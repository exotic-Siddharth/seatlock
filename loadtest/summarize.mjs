// Turns the raw output of a benchmark run into the committed results (spec §11).
// Run through tsx, because it validates against the TypeScript schemas in @seatlock/shared:
//
//   tsx loadtest/summarize.mjs run     --scenario hot-seat --strategy conditional --vus 1000
//   tsx loadtest/summarize.mjs queue   --vus 3000 --rate 200
//   tsx loadtest/summarize.mjs summary
//
// `run` and `queue` read loadtest/results/raw/ (k6 --summary-export, bench:verify output, per-VU
// queue lines) and write results/<scenario>-<strategy>.json or results/queue.json. `summary` reads
// those and writes results/summary.json and results/SUMMARY.md. Set RESULTS_DIR to use another folder.
// `summary` records its verdict in summary.json itself (`problems`, `warnings`), so the Lab page
// shows a rejected file as "Not publishable", and it exits with status 2 after writing its files
// if a safe strategy broke an invariant or the results are otherwise not trustworthy. A bad run
// can never pass for a good one, in the terminal or on the page.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BenchQueueSchema, BenchRunSchema, BenchSummarySchema, InvariantsSchema } from '@seatlock/shared';

export const SCENARIOS = ['hot-seat', 'flash-sale'];
export const STRATEGIES = ['naive', 'pessimistic', 'conditional', 'redis'];
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const resultsDir = () => process.env.RESULTS_DIR || path.join(HERE, 'results');
const rawDir = () => path.join(resultsDir(), 'raw');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const round = (n, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;

// ---------------------------------------------------------------- k6 summary-export

/** A metric of `k6 run --summary-export`: counters have count and rate, trends have avg, med, p(95) and so on. */
export function metric(k6, name) {
  const m = k6.metrics?.[name];
  if (!m) return undefined;
  return m.values ?? m; // older k6 nests the numbers under "values"
}

export function counter(k6, name) {
  return metric(k6, name)?.count ?? 0;
}

function trend(k6, name) {
  const t = metric(k6, name);
  if (!t) throw new Error(`k6 summary has no ${name}: did the scenario run?`);
  return t;
}

// ---------------------------------------------------------------- one scenario run


/** Builds and validates one BenchRun from the k6 export and the bench:verify output of that run. */
export function buildRun({ scenario, strategy, vus, k6, verify }) {
  const latency = trend(k6, 'hold_latency');
  const success = counter(k6, 'hold_success');
  const conflict = counter(k6, 'hold_conflict');
  const errors = counter(k6, 'hold_error');
  // run_ms is when each VU finished, counted from the start barrier: the run proper, without the idle wait.
  const durationSec = trend(k6, 'run_ms').max / 1000;
  if (!(durationSec > 0)) throw new Error('k6 reports a run of zero length');
  const requests = counter(k6, 'http_reqs');

  const run = {
    scenario,
    strategy,
    vus,
    durationSec: round(durationSec, 2),
    holds: { attempts: success + conflict + errors, success, conflict, errors },
    holdLatencyMs: {
      p50: round(latency.med),
      p95: round(latency['p(95)']),
      p99: round(latency['p(99)']),
      max: round(latency.max),
    },
    httpReqsPerSec: round(requests / durationSec),
    ticketsSold: verify.ticketsSold,
    seatsTotal: verify.seatsTotal,
    invariants: InvariantsSchema.parse(verify),
    orders: {
      created: counter(k6, 'orders_created'),
      paid: counter(k6, 'orders_paid'),
      failed: counter(k6, 'orders_failed'),
      errors: counter(k6, 'orders_error'),
      timeouts: counter(k6, 'orders_timeout'),
    },
    vuAborted: counter(k6, 'vu_aborted'),
  };
  return BenchRunSchema.parse(run);
}

// ---------------------------------------------------------------- waiting room

/** Reads the per-VU JSON lines k6 printed. Accepts bare JSON and k6's `msg="..."` log format. */
export function parseVuLines(text) {
  const records = [];
  for (const line of text.split('\n')) {
    let payload = line.trim();
    const logged = /msg="((?:[^"\\]|\\.)*)"/.exec(payload);
    if (logged) payload = JSON.parse(`"${logged[1]}"`);
    if (!payload.startsWith('{')) continue;
    try {
      const record = JSON.parse(payload);
      if (typeof record.vu === 'number') records.push(record);
    } catch {
      // not one of ours
    }
  }
  return records;
}

/**
 * Admission-order check. pos0 is a user's final place in line (read before the sale opened, when
 * nobody was admitted yet). The admitted count only ever grows, so if a user with a worse place
 * had already been told "admitted" before user k sent a poll that still said "waiting", the queue
 * let somebody jump the line. Returns how many users were overtaken like that, plus anything that
 * makes the measurement itself unreliable.
 */
export function checkAdmissionOrder(records) {
  const problems = [];
  const placed = records.filter((r) => Number.isInteger(r.pos0));
  if (placed.length !== records.length) {
    problems.push(`${records.length - placed.length} of ${records.length} users have no place in line (join failed or the sale had already opened)`);
  }
  const places = placed.map((r) => r.pos0).sort((a, b) => a - b);
  if (places.some((p, i) => p !== i + 1)) {
    problems.push('places in line are not exactly 1..N: someone joined or left while they were being read');
  }

  // Walking from the back of the line, remember the earliest admission seen so far.
  const byPlaceDesc = [...placed].sort((a, b) => b.pos0 - a.pos0);
  let earliestBehind = Infinity;
  let overtaken = 0;
  for (let i = 0; i < byPlaceDesc.length; ) {
    let j = i;
    while (j < byPlaceDesc.length && byPlaceDesc[j].pos0 === byPlaceDesc[i].pos0) j++;
    for (let k = i; k < j; k++) {
      if (byPlaceDesc[k].lastWaitSent !== null && byPlaceDesc[k].lastWaitSent > earliestBehind) overtaken++;
    }
    for (let k = i; k < j; k++) {
      if (byPlaceDesc[k].admittedAt !== null) earliestBehind = Math.min(earliestBehind, byPlaceDesc[k].admittedAt);
    }
    i = j;
  }

  const admitted = records.filter((r) => r.admittedAt !== null);
  if (admitted.length < records.length) problems.push(`${records.length - admitted.length} of ${records.length} users were never admitted`);
  return { outOfOrderAdmissions: overtaken, admittedTotal: admitted.length, problems };
}

/**
 * Admissions per second between the 10th and 90th percentile of admission times. Users only learn
 * of their admission when they poll (every ~3 s), so this needs a crowd large enough to span many polls.
 */
export function observedAdmitRate(records) {
  const times = records.map((r) => r.admittedAt).filter((t) => t !== null).sort((a, b) => a - b);
  if (times.length < 1000) return null;
  const lo = times[Math.floor(times.length * 0.1)];
  const hi = times[Math.floor(times.length * 0.9)];
  return hi > lo ? round((times.length * 0.8) / ((hi - lo) / 1000)) : null;
}

export function buildQueue({ vus, rate, k6, records }) {
  const { outOfOrderAdmissions, admittedTotal, problems } = checkAdmissionOrder(records);
  if (records.length !== vus) problems.push(`expected ${vus} users, saw ${records.length} reports`);
  const queue = BenchQueueSchema.parse({
    vus,
    joinP95Ms: round(trend(k6, 'queue_join_ms')['p(95)']),
    pollP95Ms: round(trend(k6, 'queue_poll_ms')['p(95)']),
    admitRatePerSec: rate,
    outOfOrderAdmissions,
    admittedTotal,
  });
  return { queue, problems, observedRate: observedAdmitRate(records) };
}

// ---------------------------------------------------------------- machine

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** How much the API replicas logged: run-bench.sh runs them at warn, so per-request logs cost no CPU. */
export function logLevelNote(level) {
  if (!level) return '';
  const quiet = ['warn', 'error', 'fatal', 'silent'].includes(level);
  return `the API replicas ran with LOG_LEVEL=${level}${quiet ? ', so per-request logging was off' : ', logging every request'}`;
}

export function describeMachine() {
  const cpus = os.cpus();
  const [dockerCpus, dockerMemBytes] = sh('docker', ['info', '--format', '{{.NCPU}} {{.MemTotal}}']).split(' ').map(Number);
  let replicas = 0;
  try {
    replicas = sh('docker', [
      'ps', '-q', '--filter', 'label=com.docker.compose.project=seatlock-stack',
      '--filter', 'label=com.docker.compose.service=api', '--filter', 'status=running',
    ]).split('\n').filter(Boolean).length;
  } catch {
    // the stack is already down: fall back to the configured count
  }
  let commit = '';
  try {
    commit = sh('git', ['rev-parse', '--short', 'HEAD']);
    if (sh('git', ['status', '--porcelain', '--', 'apps', 'packages', 'infra', 'docker-compose.yml', 'docker-compose.stack.yml', 'loadtest/k6'])) commit += ' plus uncommitted changes';
  } catch {
    // not a git checkout
  }
  const notes = [
    'k6, nginx, the API replicas, Postgres and Redis all ran on this one machine (Docker Desktop, WSL2), so they competed for the same CPUs',
    logLevelNote(process.env.LOG_LEVEL),
    commit && `commit ${commit}`,
    process.env.BENCH_NOTES,
  ].filter(Boolean).join('. ');
  return {
    cpu: cpus[0].model.replace(/\s+/g, ' ').trim(),
    logicalCores: cpus.length,
    ramGb: round(os.totalmem() / 2 ** 30),
    dockerCpus,
    dockerMemGb: round(dockerMemBytes / 2 ** 30),
    apiReplicas: replicas || Number(process.env.API_REPLICAS || 2),
    notes,
  };
}

// ---------------------------------------------------------------- summary

const INVARIANT_FIELDS = [
  'oversoldSeats', 'soldSeatsWithoutTicket', 'ticketsOnUnsoldSeats', 'paidOrdersWithoutTickets',
  'ticketsWithoutPaidOrder', 'paidAmountMismatch', 'doublePromisedSeats',
];

/** Problems that mean a result must not be believed, as human-readable lines. */
export function findProblems(summary) {
  const problems = [];
  for (const run of summary.runs) {
    const id = `${run.scenario}/${run.strategy}`;
    if (run.strategy !== 'naive' && !run.invariants.pass) {
      const broken = INVARIANT_FIELDS.filter((f) => run.invariants[f] > 0).map((f) => `${f}=${run.invariants[f]}`);
      problems.push(`${id}: invariants FAILED (${broken.join(', ')})`);
    }
    if (run.scenario === 'hot-seat') {
      if (run.holds.attempts !== run.vus) problems.push(`${id}: ${run.holds.attempts} hold attempts for ${run.vus} VUs`);
      if (run.strategy !== 'naive' && run.holds.success !== 1) {
        problems.push(`${id}: ${run.holds.success} holds succeeded on the same 4 seats, expected exactly 1`);
      }
    }
    if (run.scenario === 'flash-sale' && run.ticketsSold === 0) problems.push(`${id}: nothing was sold`);
  }
  for (const scenario of SCENARIOS) {
    for (const strategy of STRATEGIES) {
      if (!summary.runs.some((r) => r.scenario === scenario && r.strategy === strategy)) problems.push(`${scenario}/${strategy}: no result`);
    }
  }
  if (summary.queue.outOfOrderAdmissions > 0) {
    problems.push(`queue: ${summary.queue.outOfOrderAdmissions} users were overtaken by someone further back in line`);
  }
  return problems;
}

/** Cautions that do not invalidate a result but must be read alongside it. */
export function findWarnings(summary) {
  const warnings = [];
  for (const r of summary.runs) {
    const id = `${r.scenario}/${r.strategy}`;
    if (r.holds.errors > 0) warnings.push(`${id}: ${r.holds.errors} of ${r.holds.attempts} hold requests failed (not a 201 or 409), so its latency numbers mix in failures`);
    if (r.orders?.errors > 0) warnings.push(`${id}: ${r.orders.errors} order or payment requests failed (not a 201 or 202)`);
    if (r.orders?.timeouts > 0) warnings.push(`${id}: ${r.orders.timeouts} orders were still unpaid after 30 s (payment webhook did not arrive or was slow)`);
    if (r.vuAborted > 0) warnings.push(`${id}: ${r.vuAborted} of ${r.vus} VUs aborted early (failed seat-map reads or repeated hold failures), so the load was lower than configured`);
  }
  return warnings;
}

const ms = (n) => (n >= 1000 ? `${round(n / 1000, 2)} s` : `${round(n)} ms`);
const int = (n) => n.toLocaleString('en-US');

function invariantCell(run) {
  const { invariants } = run;
  const broken = INVARIANT_FIELDS.filter((f) => invariants[f] > 0 && !(run.strategy === 'naive' && f === 'doublePromisedSeats'));
  if (!invariants.pass) return `FAIL: ${broken.map((f) => `${f} ${invariants[f]}`).join(', ')}`;
  const notes = [];
  if (run.strategy === 'naive' && invariants.doublePromisedSeats > 0) notes.push(`${invariants.doublePromisedSeats} double-promised seats`);
  if (invariants.refundedOrders > 0) notes.push(`${invariants.refundedOrders} paid then refunded`);
  return notes.length > 0 ? `PASS (${notes.join(', ')})` : 'PASS';
}

const orderCell = (r) => (r.orders ? `${int(r.orders.paid)} / ${int(r.orders.failed)} / ${int(r.orders.errors)} / ${int(r.orders.timeouts)}` : '-');

export function renderMarkdown(summary, problems, warnings, observedRate) {
  const m = summary.machine;
  const q = summary.queue;
  const rows = summary.runs.map((r) =>
    [
      r.scenario, r.strategy, int(r.vus), `${r.durationSec} s`, int(r.holds.attempts), int(r.holds.success),
      int(r.holds.conflict), int(r.holds.errors), orderCell(r), int(r.vuAborted ?? 0), ms(r.holdLatencyMs.p50), ms(r.holdLatencyMs.p95), ms(r.holdLatencyMs.p99),
      ms(r.holdLatencyMs.max), int(Math.round(r.httpReqsPerSec)), `${int(r.ticketsSold)} / ${int(r.seatsTotal)}`, invariantCell(r),
    ].join(' | '),
  );
  const lines = [
    '# Seatlock benchmark results',
    '',
    `Generated ${summary.generatedAt}.`,
    '',
    '## Machine',
    '',
    `- CPU: ${m.cpu} (${m.logicalCores} logical cores), ${m.ramGb} GB RAM`,
    `- Docker: ${m.dockerCpus} CPUs, ${m.dockerMemGb} GB; ${m.apiReplicas} API replicas behind nginx`,
    `- Notes: ${m.notes}`,
    '',
    '## Seat holds',
    '',
    '| Scenario | Strategy | VUs | Duration | Hold attempts | 201 | 409 | Failed | Orders paid / failed / errors / timeouts | VUs aborted | p50 | p95 | p99 | max | HTTP req/s | Tickets sold / seats | Invariants |',
    '|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|',
    ...rows.map((r) => `| ${r} |`),
    '',
    '## Waiting room',
    '',
    `- ${int(q.vus)} users joined within 5 s, before the sale opened, and polled every ~3 s until admitted at ${q.admitRatePerSec}/s`,
    `- Join p95 ${ms(q.joinP95Ms)}, poll p95 ${ms(q.pollP95Ms)}`,
    `- Admitted ${int(q.admittedTotal)} of ${int(q.vus)}; **${q.outOfOrderAdmissions}** admitted out of order`,
    ...(observedRate ? [`- Observed admission rate about ${int(observedRate)}/s (coarse: users only see it when they poll)`] : []),
    '',
    '## How to read this',
    '',
    '- **Hold attempts** are the `POST /api/holds` calls. Each is a 201 (held), a 409 `SEATS_UNAVAILABLE` (somebody else had a seat) or a failure (anything else, including timeouts).',
    '- **Latency** is the time of those hold calls, 201 and 409 alike, as seen by k6 through nginx. **Duration** runs from the shared start barrier until the last VU finished; **HTTP req/s** is all requests in that window.',
    '- **Hot seat**: every VU asks for the same 4 seats at the same instant. A safe strategy gives exactly one 201.',
    '- **Flash sale**: VUs keep holding and paying until the event has no free seat. Orders that fail because the seat was sold twice are refunded ("paid then refunded").',
    '- **Invariants** are checked in Postgres after each run: no seat with two tickets, no sold seat without its ticket, no ticket on an unsold seat, every paid order has all its tickets and the right amount, and no two holds on one seat at the same time. Every count must be 0 (refunded orders are only reported). `naive` is the deliberately unsafe baseline: its double-promised seats are reported, but its oversell checks still count.',
    '- **Queue order**: a user is overtaken if someone further back in line had already been admitted before that user polled and was still told "waiting".',
    '',
  ];
  if (warnings.length > 0) lines.push('## Cautions', '', ...warnings.map((w) => `- ${w}`), '');
  if (problems.length > 0) lines.push('## PROBLEMS: do not publish these numbers', '', ...problems.map((p) => `- ${p}`), '');
  return lines.join('\n');
}

/**
 * summary.json: the runs, the queue result and the machine, plus the verdict on them, so the
 * Lab page (which reads only this file) can tell a rejected run from a good one.
 */
export function buildSummary({ runs, queue, machine, queueProblems = [] }) {
  const base = { generatedAt: new Date().toISOString(), machine, runs, queue };
  const problems = [...findProblems(base), ...queueProblems.map((p) => `queue: ${p}`)];
  return BenchSummarySchema.parse({ ...base, problems, warnings: findWarnings(base) });
}

// ---------------------------------------------------------------- CLI

function arg(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  const value = i >= 0 ? args[i + 1] : fallback;
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function cmdRun(args) {
  const scenario = arg(args, 'scenario');
  const strategy = arg(args, 'strategy');
  const vus = Number(arg(args, 'vus'));
  const base = path.join(rawDir(), `${scenario}-${strategy}`);
  const run = buildRun({ scenario, strategy, vus, k6: readJson(`${base}.k6.json`), verify: readJson(`${base}.verify.json`) });
  writeJson(path.join(resultsDir(), `${scenario}-${strategy}.json`), run);
  console.log(`${scenario}/${strategy}: ${run.holds.success} held, ${run.holds.conflict} conflicts, ${run.holds.errors} failed; ${run.ticketsSold}/${run.seatsTotal} sold; invariants ${run.invariants.pass ? 'PASS' : 'FAIL'}`);
}

function cmdQueue(args) {
  const vus = Number(arg(args, 'vus'));
  const rate = Number(arg(args, 'rate', '200'));
  const records = parseVuLines(readFileSync(path.join(rawDir(), 'queue-vu.ndjson'), 'utf8'));
  const { queue, problems, observedRate } = buildQueue({ vus, rate, k6: readJson(path.join(rawDir(), 'queue.k6.json')), records });
  writeJson(path.join(resultsDir(), 'queue.json'), { ...queue, observedAdmitRatePerSec: observedRate, problems });
  console.log(`queue: ${queue.admittedTotal}/${queue.vus} admitted, ${queue.outOfOrderAdmissions} out of order${problems.length ? `; PROBLEMS: ${problems.join('; ')}` : ''}`);
}

function cmdSummary() {
  const runs = [];
  for (const scenario of SCENARIOS) {
    for (const strategy of STRATEGIES) {
      const file = path.join(resultsDir(), `${scenario}-${strategy}.json`);
      if (existsSync(file)) runs.push(BenchRunSchema.parse(readJson(file)));
    }
  }
  const { observedAdmitRatePerSec, problems: queueProblems = [], ...queue } = readJson(path.join(resultsDir(), 'queue.json'));
  const summary = buildSummary({ runs, queue: BenchQueueSchema.parse(queue), machine: describeMachine(), queueProblems });
  const { problems, warnings } = summary;
  writeJson(path.join(resultsDir(), 'summary.json'), summary);
  writeFileSync(path.join(resultsDir(), 'SUMMARY.md'), renderMarkdown(summary, problems, warnings, observedAdmitRatePerSec));

  console.log(`wrote ${path.join(resultsDir(), 'summary.json')} and SUMMARY.md (${runs.length} runs)`);
  for (const w of warnings) console.warn(`WARNING: ${w}`);
  for (const p of problems) console.error(`PROBLEM: ${p}`);
  if (problems.length > 0) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const commands = { run: cmdRun, queue: cmdQueue, summary: cmdSummary };
  if (!commands[command]) {
    console.error('usage: summarize.mjs run --scenario S --strategy T --vus N | queue --vus N [--rate R] | summary');
    process.exit(64);
  }
  try {
    commands[command](args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
