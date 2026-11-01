# 0002. A single PostgreSQL database is the only storage

- Status: Accepted
- Since: 0.1.0 (extended to runtime state in 1.0.0)

## Context

Maa targets one store of small or medium size, run by a team with little operations capacity. A
production backend needs more than business tables: sessions, rate-limit counters, idempotency
keys, reliable events, background jobs and an audit trail. The usual answer is Redis plus a message
broker plus a scheduler, each of which must be deployed, secured, monitored and backed up.

In 0.1.0 the non-business state lived in process memory (rate-limit counters, inline events). That
broke as soon as a second instance ran behind a load balancer: counters were per instance and reset
on restart, and an event was lost if the process died between `COMMIT` and the listener call.

## Decision

One PostgreSQL database holds everything, reached through one connection pool built by
`createPool()` (`src/db/connection.ts`). No part of the framework opens its own connection or uses
another storage system.

Runtime state lives in tables created by `src/runtime/migrations.ts` (`0900_runtime_tables`):

| Table | Purpose |
|---|---|
| `auth_sessions` | server-side sessions behind tokens (ADR 0006) |
| `rate_limits` | shared rate-limit counters (ADR 0010) |
| `idempotency_keys` | stored responses for `Idempotency-Key` |
| `outbox_events` | events written in the same transaction as the change (ADR 0007) |
| `jobs` | background and recurring jobs (ADR 0008) |
| `audit_log` | every owner and staff write |

Redis, message brokers, multi-tenancy and microservices are explicit non-goals (`docs/ROADMAP.md`).

## Consequences

- One backup is a consistent snapshot of orders, stock, sessions, pending events and jobs.
- A business change and its event or job commit atomically: no dual-write problem.
- Several instances run safely with nothing but the database (`tests/integration/multi-instance.test.ts`).
- The database is the single point of failure and the throughput ceiling. During an outage nothing
  works, including login (see `docs/RUNBOOK.md`).
- Extra queries per request: one primary-key session lookup per authenticated request, one or two
  rate-limit statements on guarded routes. Both are cheap next to the 35 ms scrypt hash they protect.
- Each instance's worker polls `outbox_events` and `jobs` every second (partial indexes keep the
  polls cheap on an idle queue).
- Runtime tables need cleanup; the hourly `system.cleanup` job does it (`src/app.ts`).
- `DB_POOL_MAX` times the number of instances must stay below PostgreSQL `max_connections`.

## Alternatives considered

- **Redis for sessions, limits and queues.** Faster per operation, but a second system to run and
  secure, and events could no longer commit atomically with the data.
- **A message broker (RabbitMQ, Kafka, SQS).** Same dual-write problem without an outbox, and far
  more operational weight than a single store needs.
- **Process memory.** The 0.1.0 approach. Kept only as `rateLimitStore: "memory"` for
  single-instance setups and tests.
