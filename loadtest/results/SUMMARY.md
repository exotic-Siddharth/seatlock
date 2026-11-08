# Seatlock benchmark results

Generated 2026-11-08T09:25:54.376Z.

## Machine

- CPU: 11th Gen Intel(R) Core(TM) i7-1195G7 @ 2.90GHz (8 logical cores), 31.7 GB RAM
- Docker: 8 CPUs, 15.5 GB; 2 API replicas behind nginx
- Notes: k6, nginx, the API replicas, Postgres and Redis all ran on this one machine (Docker Desktop, WSL2), so they competed for the same CPUs. the API replicas ran with LOG_LEVEL=warn, so per-request logging was off. commit 7d01a1f. Run on the author's laptop while another unrelated CPU-heavy python job (ML training from a different project) kept the CPU at ~90%; idle Postgres/Redis containers of two other projects were also running. Numbers are therefore pessimistic; correctness invariants are unaffected.

## Seat holds

| Scenario | Strategy | VUs | Duration | Hold attempts | 201 | 409 | Failed | Orders paid / failed / errors / timeouts | VUs aborted | p50 | p95 | p99 | max | HTTP req/s | Tickets sold / seats | Invariants |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|
| hot-seat | naive | 1,000 | 10.31 s | 1,000 | 1 | 999 | 0 | 0 / 0 / 0 / 0 | 0 | 5.3 s | 8.81 s | 9.14 s | 10.05 s | 97 | 0 / 10,000 | PASS |
| hot-seat | pessimistic | 1,000 | 8.91 s | 1,000 | 1 | 999 | 0 | 0 / 0 / 0 / 0 | 0 | 6.31 s | 8.16 s | 8.27 s | 8.63 s | 112 | 0 / 10,000 | PASS |
| hot-seat | conditional | 1,000 | 7.56 s | 1,000 | 1 | 999 | 0 | 0 / 0 / 0 / 0 | 0 | 4.41 s | 6.51 s | 6.82 s | 7.26 s | 133 | 0 / 10,000 | PASS |
| hot-seat | redis | 1,000 | 6.5 s | 1,000 | 1 | 999 | 0 | 0 / 0 / 0 / 0 | 0 | 2.57 s | 5.33 s | 5.87 s | 5.95 s | 154 | 0 / 10,000 | PASS |
| flash-sale | naive | 2,000 | 132.27 s | 2,813 | 794 | 210 | 1,809 | 473 / 0 / 151 / 80 | 1,615 | 66.4 ms | 56.58 s | 60 s | 60.08 s | 68 | 1,212 / 10,000 | PASS (5 double-promised seats, 1 paid then refunded) |
| flash-sale | pessimistic | 2,000 | 125.5 s | 6,305 | 3,073 | 3,085 | 147 | 2,587 / 0 / 26 / 119 | 1,132 | 1.92 s | 16.5 s | 53.3 s | 60 s | 157 | 5,409 / 10,000 | PASS |
| flash-sale | conditional | 2,000 | 126.55 s | 5,458 | 2,163 | 1,512 | 1,783 | 1,604 / 0 / 145 / 189 | 1,206 | 895.1 ms | 24.36 s | 60 s | 60.02 s | 131 | 3,624 / 10,000 | PASS |
| flash-sale | redis | 2,000 | 123.37 s | 6,487 | 2,100 | 1,497 | 2,890 | 1,539 / 0 / 131 / 211 | 1,484 | 708.4 ms | 7.95 s | 43.79 s | 60 s | 147 | 3,442 / 10,000 | PASS |

## Waiting room

- 3,000 users joined within 5 s, before the sale opened, and polled every ~3 s until admitted at 200/s
- Join p95 2.96 s, poll p95 296.9 ms
- Admitted 3,000 of 3,000; **0** admitted out of order
- Observed admission rate about 187.9/s (coarse: users only see it when they poll)

## How to read this

- **Hold attempts** are the `POST /api/holds` calls. Each is a 201 (held), a 409 `SEATS_UNAVAILABLE` (somebody else had a seat) or a failure (anything else, including timeouts).
- **Latency** is the time of those hold calls, 201 and 409 alike, as seen by k6 through nginx. **Duration** runs from the shared start barrier until the last VU finished; **HTTP req/s** is all requests in that window.
- **Hot seat**: every VU asks for the same 4 seats at the same instant. A safe strategy gives exactly one 201.
- **Flash sale**: VUs keep holding and paying until the event has no free seat. Orders that fail because the seat was sold twice are refunded ("paid then refunded").
- **Invariants** are checked in Postgres after each run: no seat with two tickets, no sold seat without its ticket, no ticket on an unsold seat, every paid order has all its tickets and the right amount, and no two holds on one seat at the same time. Every count must be 0 (refunded orders are only reported). `naive` is the deliberately unsafe baseline: its double-promised seats are reported, but its oversell checks still count.
- **Queue order**: a user is overtaken if someone further back in line had already been admitted before that user polled and was still told "waiting".

## Cautions

- flash-sale/naive: 1809 of 2813 hold requests failed (not a 201 or 409), so its latency numbers mix in failures
- flash-sale/naive: 151 order or payment requests failed (not a 201 or 202)
- flash-sale/naive: 80 orders were still unpaid after 30 s (payment webhook did not arrive or was slow)
- flash-sale/naive: 1615 of 2000 VUs aborted early (failed seat-map reads or repeated hold failures), so the load was lower than configured
- flash-sale/pessimistic: 147 of 6305 hold requests failed (not a 201 or 409), so its latency numbers mix in failures
- flash-sale/pessimistic: 26 order or payment requests failed (not a 201 or 202)
- flash-sale/pessimistic: 119 orders were still unpaid after 30 s (payment webhook did not arrive or was slow)
- flash-sale/pessimistic: 1132 of 2000 VUs aborted early (failed seat-map reads or repeated hold failures), so the load was lower than configured
- flash-sale/conditional: 1783 of 5458 hold requests failed (not a 201 or 409), so its latency numbers mix in failures
- flash-sale/conditional: 145 order or payment requests failed (not a 201 or 202)
- flash-sale/conditional: 189 orders were still unpaid after 30 s (payment webhook did not arrive or was slow)
- flash-sale/conditional: 1206 of 2000 VUs aborted early (failed seat-map reads or repeated hold failures), so the load was lower than configured
- flash-sale/redis: 2890 of 6487 hold requests failed (not a 201 or 409), so its latency numbers mix in failures
- flash-sale/redis: 131 order or payment requests failed (not a 201 or 202)
- flash-sale/redis: 211 orders were still unpaid after 30 s (payment webhook did not arrive or was slow)
- flash-sale/redis: 1484 of 2000 VUs aborted early (failed seat-map reads or repeated hold failures), so the load was lower than configured
