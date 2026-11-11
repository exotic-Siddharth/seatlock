# Integration notes

Left open on purpose (the README does not exist yet):
L1: the stack lives in docker-compose.stack.yml (its own Compose project `seatlock-stack`, own Postgres/Redis, nginx on 8088, a one-shot seed), so the README quick start is `docker compose -f docker-compose.yml -f docker-compose.stack.yml --profile stack up -d --build`, not plain `--profile stack`. Settled in the fix wave: kept as two files on purpose (Decisions log, 2026-11-08). Benchmark: `bash loadtest/run-bench.sh` (needs `npm ci` for tsx). Results go to loadtest/results/, smoke runs to the gitignored loadtest/results-quick/.
