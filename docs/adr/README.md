# Architecture decision records

Why Maa is built the way it is. Each record states the context, the decision, its consequences
(including the costs we accepted) and the alternatives we rejected. How these records are kept is
itself decision [0001](0001-record-architecture-decisions.md).

| # | Decision | Status | Since |
|---|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted | 1.0.0 |
| [0002](0002-single-postgresql-storage.md) | A single PostgreSQL database is the only storage (no Redis, no broker) | Accepted | 0.1.0, extended 1.0.0 |
| [0003](0003-repositories-over-raw-sql.md) | Repositories over hand-written SQL, no ORM | Accepted | 0.1.0 |
| [0004](0004-in-house-validator.md) | An in-house validator instead of Zod | Accepted | 0.1.0, v2 in 1.0.0 |
| [0005](0005-money-as-integer-minor-units.md) | Money as integer minor units in BIGINT | Accepted | 0.1.0, BIGINT in 1.0.0 |
| [0006](0006-server-side-sessions.md) | Server-side sessions behind signed tokens | Accepted | 1.0.0 |
| [0007](0007-transactional-outbox.md) | Transactional outbox for events | Accepted | 1.0.0 |
| [0008](0008-postgres-job-queue.md) | Postgres job queue with `SKIP LOCKED` | Accepted | 1.0.0 |
| [0009](0009-own-http-layer-and-router.md) | Own HTTP layer and router instead of Express or Fastify | Accepted | 0.1.0, hardened 1.0.0 |
| [0010](0010-rate-limits-in-postgres.md) | Rate limits stored in PostgreSQL | Accepted | 1.0.0 |
| [0011](0011-lock-ordering-and-transaction-retry.md) | Fixed lock ordering and automatic transaction retry | Accepted | 1.0.0 |
| [0012](0012-backward-compatible-evolution.md) | Backward-compatible evolution of the API | Accepted | 1.0.0 |
| [0013](0013-optimistic-concurrency-etag.md) | Optimistic concurrency with version and ETag | Accepted | 1.0.0 |

## Adding a record

1. Copy the structure of an existing record: title `# NNNN. Title`, a status and "Since" line, then
   Context, Decision, Consequences, Alternatives considered.
2. Use the next free number and a short kebab-case file name. Never renumber or rename a record:
   code comments link to them by file name (0004 to 0008 are referenced from `src/`).
3. Add a row to the table above in the same pull request as the change it records.
4. To change a decision, write a new record and set the old one's status to
   `Superseded by NNNN`. Do not rewrite an accepted record.
