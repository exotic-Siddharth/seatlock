import type { BenchRun, BenchScenario, BenchSummary, Invariants } from '@seatlock/shared';
import { OctagonX, TriangleAlert } from 'lucide-react';
import { Badge, Card } from '../../components/ui';
import { formatDateTime, formatNumber } from '../../lib/format';
import { BarChart } from './BarChart';

const STRATEGY_ORDER = ['naive', 'pessimistic', 'conditional', 'redis'] as const;

/**
 * Each scenario's throughput is the number it exists to measure. Raw HTTP req/s would reward a
 * strategy for conflicting more: a flash-sale 409 is retried, and each retry is another request.
 */
const SCENARIOS: { id: BenchScenario; name: string; blurb: string; throughput: { title: string; value: (r: BenchRun) => number } }[] = [
  {
    id: 'hot-seat',
    name: 'Hot seat',
    blurb: 'Every user tries to hold the same few seats at the same instant. A safe strategy lets exactly one of them win.',
    // One hold request per buyer, no retries: how fast the whole crowd got its answer.
    throughput: { title: 'Buyers answered per second', value: (r) => r.holds.attempts / r.durationSec },
  },
  {
    id: 'flash-sale',
    name: 'Flash sale',
    blurb: 'A crowd buys across the whole venue: pick seats, hold, pay, retry on conflict, until the event sells out or time runs out.',
    throughput: { title: 'Seats sold per second', value: (r) => r.ticketsSold / r.durationSec },
  },
];

/** The invariant counters that make a run fail, with the words used in the table. */
const VIOLATIONS: [Exclude<keyof Invariants, 'pass' | 'refundedOrders'>, string][] = [
  ['oversoldSeats', 'oversold'],
  ['soldSeatsWithoutTicket', 'sold without ticket'],
  ['ticketsOnUnsoldSeats', 'tickets on unsold seats'],
  ['paidOrdersWithoutTickets', 'paid without tickets'],
  ['ticketsWithoutPaidOrder', 'tickets without paid order'],
  ['paidAmountMismatch', 'amount mismatch'],
  ['doublePromisedSeats', 'double-promised'],
];

const ms = (v: number) => `${formatNumber(Math.round(v * 10) / 10)} ms`;
const perSec = (v: number) => `${formatNumber(Math.round(v))}/s`;
const DASH = '—';

/** Paid orders out of the orders created, or a dash for result files from before orders were counted. */
const ordersCell = (r: BenchRun) => (r.orders ? `${formatNumber(r.orders.paid)} / ${formatNumber(r.orders.created)}` : DASH);

const TH = 'px-3 py-2 text-xs font-semibold tracking-wide text-muted uppercase';
const TD = 'px-3 py-2.5 text-right tabular-nums';

function runsFor(summary: BenchSummary, scenario: BenchScenario): BenchRun[] {
  return summary.runs
    .filter((r) => r.scenario === scenario)
    .sort((a, b) => STRATEGY_ORDER.indexOf(a.strategy) - STRATEGY_ORDER.indexOf(b.strategy));
}

/** The problems in the file's verdict that name this run ("hot-seat/conditional: ..."). */
const problemsOf = (summary: BenchSummary, run: BenchRun) => (summary.problems ?? []).filter((p) => p.startsWith(`${run.scenario}/${run.strategy}:`));

/**
 * Fail when an invariant broke; Rejected when the file's verdict lists the run (say, a safe
 * hot-seat run with no winner, whose invariants are trivially clean); naive's clean run is the
 * Baseline it exists to be, never a green Pass.
 */
function badgeFor(run: BenchRun, rejected: boolean): { tone: 'success' | 'danger' | 'neutral'; label: string } {
  if (!run.invariants.pass) return { tone: 'danger', label: 'Fail' };
  if (rejected) return { tone: 'danger', label: 'Rejected' };
  if (run.strategy === 'naive') return { tone: 'neutral', label: 'Baseline' };
  return { tone: 'success', label: 'Pass' };
}

function InvariantCell({ run, rejected }: { run: BenchRun; rejected: boolean }) {
  const inv: Invariants = run.invariants;
  const broken = VIOLATIONS.filter(([key]) => inv[key] !== 0);
  const badge = badgeFor(run, rejected);
  return (
    <td className="px-3 py-2.5 text-left">
      <Badge tone={badge.tone}>{badge.label}</Badge>
      {broken.length > 0 && (
        <span className="mt-1 block text-xs text-muted">
          {broken.map(([key, words]) => `${formatNumber(inv[key])} ${words}`).join(', ')}
        </span>
      )}
      {inv.refundedOrders > 0 && <span className="block text-xs text-muted">{formatNumber(inv.refundedOrders)} paid, then refunded</span>}
    </td>
  );
}

function ScenarioResults({ summary, scenario }: { summary: BenchSummary; scenario: (typeof SCENARIOS)[number] }) {
  const runs = runsFor(summary, scenario.id);
  if (runs.length === 0) return null;
  const vus = runs[0]!.vus;
  const bars = (pick: (r: BenchRun) => number) => runs.map((r) => ({ strategy: r.strategy, value: pick(r) }));

  return (
    <section aria-labelledby={`scenario-${scenario.id}`} className="mt-10">
      <h3 id={`scenario-${scenario.id}`} className="font-display text-xl font-bold">
        {scenario.name}
      </h3>
      <p className="mt-1 max-w-3xl text-muted">
        {scenario.blurb} {formatNumber(vus)} virtual users.
      </p>

      <Card className="mt-4 overflow-x-auto">
        <table aria-label={`${scenario.name} results`} className="w-full min-w-[64rem] text-sm">
          <thead className="border-b border-line">
            <tr>
              <th scope="col" className={`${TH} text-left`}>Strategy</th>
              <th scope="col" className={`${TH} text-right`}>Holds won</th>
              <th scope="col" className={`${TH} text-right`}>Conflicts</th>
              <th scope="col" className={`${TH} text-right`}>Errors</th>
              <th scope="col" className={`${TH} text-right`}>p50</th>
              <th scope="col" className={`${TH} text-right`}>p95</th>
              <th scope="col" className={`${TH} text-right`}>p99</th>
              <th scope="col" className={`${TH} text-right`} title="Every HTTP request k6 sent, 409 retries and order polls included">
                HTTP req/s
              </th>
              <th scope="col" className={`${TH} text-right`}>Sold</th>
              <th scope="col" className={`${TH} text-right`}>Orders paid</th>
              <th scope="col" className={`${TH} text-right`}>VUs aborted</th>
              <th scope="col" className={`${TH} text-left`}>Invariants</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {runs.map((run) => (
              <tr key={run.strategy}>
                <th scope="row" className="px-3 py-2.5 text-left font-semibold">{run.strategy}</th>
                <td className={TD}>{formatNumber(run.holds.success)}</td>
                <td className={TD}>{formatNumber(run.holds.conflict)}</td>
                <td className={TD}>{formatNumber(run.holds.errors)}</td>
                <td className={TD}>{ms(run.holdLatencyMs.p50)}</td>
                <td className={TD}>{ms(run.holdLatencyMs.p95)}</td>
                <td className={TD}>{ms(run.holdLatencyMs.p99)}</td>
                <td className={TD}>{perSec(run.httpReqsPerSec)}</td>
                <td className={TD}>
                  {formatNumber(run.ticketsSold)} / {formatNumber(run.seatsTotal)}
                </td>
                <td className={TD}>{ordersCell(run)}</td>
                <td className={TD}>{run.vuAborted === undefined ? DASH : formatNumber(run.vuAborted)}</td>
                <InvariantCell run={run} rejected={problemsOf(summary, run).length > 0} />
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="mt-6 grid gap-8 md:grid-cols-2">
        <BarChart title={`p95 hold latency, ${scenario.name.toLowerCase()} (lower is better)`} bars={bars((r) => r.holdLatencyMs.p95)} format={ms} />
        <BarChart
          title={`${scenario.throughput.title}, ${scenario.name.toLowerCase()} (higher is better)`}
          bars={bars(scenario.throughput.value)}
          format={perSec}
        />
      </div>
    </section>
  );
}

function QueueResults({ queue }: { queue: BenchSummary['queue'] }) {
  const stats: [string, string][] = [
    ['Join p95', ms(queue.joinP95Ms)],
    ['Status poll p95', ms(queue.pollP95Ms)],
    ['Admission rate', perSec(queue.admitRatePerSec)],
    ['Admitted out of order', formatNumber(queue.outOfOrderAdmissions)],
    ['Admitted in total', formatNumber(queue.admittedTotal)],
  ];
  return (
    <section aria-labelledby="queue-results" className="mt-10">
      <h3 id="queue-results" className="font-display text-xl font-bold">
        Waiting room
      </h3>
      <p className="mt-1 max-w-3xl text-muted">
        {formatNumber(queue.vus)} users join a queue-enabled sale within seconds, all before it opens, so their places are drawn by
        lottery when it does; then they poll until they are let in. Fair here means nobody is admitted ahead of someone with an earlier
        place in that draw. First-come order for people who join after the sale opens is not part of this benchmark.
      </p>
      <dl className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {stats.map(([label, value]) => (
          <Card key={label} className="p-4">
            <dt className="text-sm text-muted">{label}</dt>
            <dd className="mt-1 font-display text-2xl font-bold tabular-nums">{value}</dd>
          </Card>
        ))}
      </dl>
    </section>
  );
}

/** summarize.mjs's verdict on the file: a red banner if it must not be published, amber cautions otherwise. */
function Verdict({ summary }: { summary: BenchSummary }) {
  const problems = summary.problems ?? [];
  const warnings = summary.warnings ?? [];
  return (
    <>
      {problems.length > 0 && (
        <div role="alert" className="mb-6 rounded-2xl border border-danger bg-danger/8 p-5">
          <p className="flex items-center gap-2 font-display text-lg font-bold text-danger">
            <OctagonX aria-hidden className="size-5" /> Not publishable: these results failed their own checks
          </p>
          <ul className="mt-2 list-disc pl-6 text-sm text-ink">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="mb-6 rounded-2xl border border-warning bg-warning/8 p-5">
          <p className="flex items-center gap-2 font-display text-lg font-bold text-warning">
            <TriangleAlert aria-hidden className="size-5" /> Warnings
          </p>
          <ul className="mt-2 list-disc pl-6 text-sm text-ink">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {summary.problems === undefined && (
        <p className="mb-6 text-sm text-muted">This results file predates the publishability check, so it carries no verdict.</p>
      )}
    </>
  );
}

export function Results({ summary }: { summary: BenchSummary }) {
  const { machine } = summary;
  return (
    <div>
      <Verdict summary={summary} />
      <p className="max-w-3xl text-muted">
        Every number below was measured by k6 against the real stack and read from a committed file, then each run was checked against
        database invariants: no seat sold twice, every paid order has its tickets, every ticket belongs to a paid order.
      </p>
      <p className="mt-3 text-sm text-muted">
        {machine.cpu} &middot; {machine.logicalCores} logical cores &middot; {machine.ramGb} GB RAM &middot; Docker given {machine.dockerCpus} CPUs
        and {machine.dockerMemGb} GB &middot; {machine.apiReplicas} API replicas
      </p>
      <p className="text-sm text-muted">
        Run on {formatDateTime(summary.generatedAt)}.{machine.notes && ` ${machine.notes}`}
      </p>

      {SCENARIOS.map((scenario) => (
        <ScenarioResults key={scenario.id} summary={summary} scenario={scenario} />
      ))}
      <QueueResults queue={summary.queue} />
    </div>
  );
}
