# 0008. Postgres job queue with SKIP LOCKED

- Status: Accepted
- Since: 1.0.0

## Context

The framework needs recurring maintenance and deferred work:

- `orders.releaseExpiredHolds` every minute: cancel unpaid online orders after the provider's hold
  time and return their stock;
- `cart.cleanupAbandoned` daily: delete guest carts untouched for 30 days;
- `system.cleanup` hourly: delete expired idempotency keys, rate-limit rows, sessions, processed or
  dead outbox events and jobs, and expired password-reset codes;
- jobs defined by plugins.

With several instances, a `setInterval` in each process runs every job N times. A cron container or
a broker adds infrastructure that ADR 0002 rules out.

## Decision

`JobQueue` (`src/runtime/jobs.ts`) over the `jobs` table, driven by the same `BackgroundWorker` as
the outbox.

- `define(name, handler, { maxAttempts = 5 })` registers a handler (at startup, in every instance).
- `enqueue(name, payload, { runAt, dedupeKey, db })` inserts a row; passing a transaction client
  enqueues atomically with the change. `ON CONFLICT (dedupe_key) DO NOTHING` makes a duplicate a
  no-op that returns `null`.
- `schedule(name, everyMs)` (minimum 1000 ms): every instance tries to enqueue
  `dedupe_key = "<name>@<floor(now / everyMs)>"`. The unique constraint accepts the first insert per
  time bucket and drops the rest, so a recurring job runs once per interval across all instances.
- Claiming uses `UPDATE ... WHERE id IN (SELECT ... ORDER BY run_at, id FOR UPDATE SKIP LOCKED)`
  with a 300 s lease and `attempts + 1`.
- A failure is retried after `min(3600, 5 * 2^attempts)` seconds; after `max_attempts` the job is
  dead (`dead_at`, `last_error`), logged as an error and counted in `jobs_total{result="dead"}`.

## Consequences

- Background work without extra infrastructure, enqueued transactionally when needed.
- Recurring jobs are not duplicated across instances (`tests/integration/operations.test.ts`).
- At least once: a job whose lease expires (crash, or a run longer than 300 s) runs again, so
  handlers must be idempotent.
- Schedules are wall-clock buckets of a fixed interval, not cron expressions; "daily" means once per
  UTC day bucket, not at a chosen hour.
- `dedupe_key` is unique for as long as the row exists. A custom dedupe key blocks re-enqueueing
  until `system.cleanup` deletes the finished row (7 days after `done_at`).
- During a rolling deploy, an old instance can claim a job that only the new version defines; it
  fails with "No handler is defined" and uses up attempts (about 2.5 minutes of retries with the
  default 5 attempts).
- Polling cost: one claim query per instance per second when idle, served by a partial index.

## Alternatives considered

- **`setInterval` / node-cron per instance.** Duplicates every run across instances.
- **pg_cron.** Not available on every managed PostgreSQL, and runs SQL, not plugin code.
- **pg-boss or graphile-worker.** Cron syntax and more features, at the cost of a dependency and a
  second schema. Reasonable to adopt if job needs outgrow this queue.
- **BullMQ on Redis, OS cron, Kubernetes CronJob.** Extra infrastructure (ADR 0002).
