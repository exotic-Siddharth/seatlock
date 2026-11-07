#!/usr/bin/env bash
# Runs the whole benchmark (spec §11) against the Docker stack: nginx + 2 API replicas + Postgres + Redis.
#
#   bash loadtest/run-bench.sh            full run:  1,000 / 2,000 / 3,000 VUs, flash sale up to 120 s   -> loadtest/results/
#   bash loadtest/run-bench.sh --quick    smoke run: 200 VUs everywhere, flash sale up to 30 s           -> loadtest/results-quick/
#   bash loadtest/run-bench.sh --down     stop the stack when finished (default: leave it running)
#
# For every scenario (hot-seat, flash-sale) and strategy (naive, pessimistic, conditional, redis) it resets the
# bench event, runs k6, waits for in-flight payments to settle, checks the invariants in Postgres and saves
# results/<scenario>-<strategy>.json. Then it runs the waiting-room scenario and writes summary.json and
# SUMMARY.md. Exit status 2 means the results were written but are NOT trustworthy (a safe strategy broke an
# invariant, a run is missing, ...): do not publish them.
#
# Set BENCH_NOTES="..." to record anything else that was loading the machine (it goes into summary.json).
# Needs: Docker, and `npm ci` once (for tsx, which runs summarize.mjs).

set -Eeuo pipefail
# Git Bash on Windows would otherwise rewrite arguments like /loadtest/k6/hot-seat.js into C:/Program Files/Git/...
export MSYS_NO_PATHCONV=1

cd "$(dirname "${BASH_SOURCE[0]}")/.."

QUICK=0
DOWN=0
for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=1 ;;
    --down) DOWN=1 ;;
    -h | --help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 64 ;;
  esac
done

if [ "$QUICK" = 1 ]; then
  HOT_VUS=200 FLASH_VUS=200 QUEUE_VUS=200 FLASH_SECONDS=30 USERS=500 QUEUE_OPENS_IN=45 RESULTS=results-quick
  export BENCH_NOTES="QUICK RUN (200 VUs, 30 s): a smoke test, not representative.${BENCH_NOTES:+ $BENCH_NOTES}"
else
  HOT_VUS=1000 FLASH_VUS=2000 QUEUE_VUS=3000 FLASH_SECONDS=120 USERS=5000 QUEUE_OPENS_IN=75 RESULTS=results
fi
QUEUE_RATE=200 # events admit_rate_per_sec for bench-queue, set by bench:seed
STRATEGIES="naive pessimistic conditional redis"
export RESULTS_DIR="loadtest/$RESULTS"
RAW="$RESULTS_DIR/raw"

if [ ! -x node_modules/.bin/tsx ]; then
  echo "tsx not found: run 'npm ci' in the repository root first" >&2
  exit 1
fi

dc() { docker compose -f docker-compose.yml -f docker-compose.stack.yml "$@"; }
# One-off bench tools from the API image: seed-bench / verify-bench.
tool() { local script=$1; shift; dc --profile stack --profile bench run --rm -T seeder node "dist/scripts/$script.js" "$@"; }
k6() { dc --profile stack --profile bench run --rm -T k6 run --quiet "$@"; }
step() { printf '\n==== %s\n' "$*"; }

trap 'echo "run-bench.sh failed near line $LINENO; the stack is left running for inspection (docker compose -f docker-compose.yml -f docker-compose.stack.yml --profile stack logs)" >&2' ERR

rm -rf "$RESULTS_DIR"
mkdir -p "$RAW"
chmod a+rwx "$RAW" 2>/dev/null || true # k6 runs as another user inside its container

step "Starting the stack (BENCH_MODE=1)"
export BENCH_MODE=1
dc --profile stack up -d --build --wait --wait-timeout 300
if [ "$(dc exec -T api printenv BENCH_MODE | tr -d '\r')" != 1 ]; then
  echo "the API replicas are not running with BENCH_MODE=1" >&2
  exit 1
fi

step "Seeding $USERS bench users and the hot event"
tool seed-bench --users "$USERS" --events hot --out /loadtest/.tokens.json >/dev/null

reset_hot() {
  tool seed-bench --users 0 --events hot --out /loadtest/.tokens.json >/dev/null
  sleep 2
}

step "Warm-up (not recorded): 100 VUs on the hot seat"
reset_hot
k6 -e STRATEGY=conditional -e VUS=100 -e RUN_ID=warmup /loadtest/k6/hot-seat.js >/dev/null

for scenario in hot-seat flash-sale; do
  case "$scenario" in
    hot-seat) vus=$HOT_VUS ;;
    flash-sale) vus=$FLASH_VUS ;;
  esac
  for strategy in $STRATEGIES; do
    name="$scenario-$strategy"
    step "$scenario / $strategy ($vus VUs)"
    reset_hot
    k6 -e STRATEGY="$strategy" -e VUS="$vus" -e MAX_SECONDS="$FLASH_SECONDS" -e RUN_ID="$(date +%s)-$name" \
      --summary-export "/loadtest/$RESULTS/raw/$name.k6.json" "/loadtest/k6/$scenario.js" | tee "$RAW/$name.k6.log"
    # Pending payments and the expiry sweeper settle; verify only reads a state nothing is still changing.
    sleep 6
    tool verify-bench --event bench-hot --strategy "$strategy" >"$RAW/$name.verify.json"
    npx --no-install tsx loadtest/summarize.mjs run --scenario "$scenario" --strategy "$strategy" --vus "$vus"
    sleep 4
  done
done

step "Waiting room ($QUEUE_VUS VUs, admitted at $QUEUE_RATE/s)"
tool seed-bench --users 0 --events queue --queue-opens-in "$QUEUE_OPENS_IN" --out /loadtest/.tokens.json >/dev/null
k6 -e VUS="$QUEUE_VUS" --summary-export "/loadtest/$RESULTS/raw/queue.k6.json" \
  --console-output "/loadtest/$RESULTS/raw/queue-vu.ndjson" /loadtest/k6/queue.js | tee "$RAW/queue.k6.log"
npx --no-install tsx loadtest/summarize.mjs queue --vus "$QUEUE_VUS" --rate "$QUEUE_RATE"

step "Summary"
status=0
npx --no-install tsx loadtest/summarize.mjs summary || status=$?

if [ "$DOWN" = 1 ]; then
  step "Stopping the stack"
  dc --profile stack --profile bench down
else
  echo
  echo "Stack still running at http://localhost:8088. Stop it with:"
  echo "  docker compose -f docker-compose.yml -f docker-compose.stack.yml --profile stack --profile bench down"
fi
echo
echo "Results: $RESULTS_DIR/summary.json and $RESULTS_DIR/SUMMARY.md"
exit "$status"
