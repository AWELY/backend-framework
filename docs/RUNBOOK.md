# Runbook: operating Maa in production

For whoever deploys and is on call for a Maa store. Commands assume the store's own entry point
(`index.js` and `migrate.js` from `maa create`, or your equivalent). The reference image in this
repository runs `dist/dev-server.js`, which has no plugins; use it for trials, not for a real store.

Requirements: Node.js 24+, PostgreSQL 15+ (CI and `docker-compose.yml` use 17).

## 1. Topology

- One or more stateless app instances behind a reverse proxy or load balancer that terminates TLS.
- One PostgreSQL database. All state lives there, including sessions, rate limits, idempotency keys,
  the event outbox, jobs and the audit log (ADR 0002). There is no Redis or broker to run.
- Every instance runs a background worker (events and jobs). No separate worker deployment is needed.
- Size the pool so that `DB_POOL_MAX` x instances, plus a migration job and admin sessions, stays
  below PostgreSQL `max_connections`.

## 2. Configuration

The full list, with defaults and comments, is `.env.example`. `loadConfig()` validates every
variable at startup and reports all problems in one error; the process does not start with a bad
value. Production checklist:

| Variable | Production value |
|---|---|
| `NODE_ENV` | `production` (makes `LOG_FORMAT` default to `json`) |
| `OWNER_API_KEY`, `AUTH_TOKEN_SECRET` | 32+ random characters each, from a secret manager. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `*_PREVIOUS` | Empty except during a rotation (section 8) |
| `DATABASE_URL` | Dedicated database user for the app |
| `CORS_ORIGIN` | Your storefront origin(s), comma-separated. Not `*` unless the API is meant to be public |
| `TRUST_PROXY` | `true` only behind exactly one trusted proxy that appends `X-Forwarded-For` |
| `HSTS` | `true` only if every request reaches users over HTTPS |
| `METRICS_TOKEN` | Set it, or block `/metrics` at the proxy |
| `DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS`, `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`, `DB_CONNECTION_TIMEOUT_MS` | Defaults 10, 15000, 30000, 5000 |
| `SHUTDOWN_TIMEOUT_MS` | Default 10000; keep below the orchestrator's grace period |
| `BODY_LIMIT_BYTES` | Default 1 MiB; checkout bodies are under 5 KB |
| `API_BASE_PATH` | Optional prefix such as `/v1`; system routes stay at the root |
| `CURRENCY` | Set once before launch. Prices are stored in minor units of this currency; changing it later relabels prices without converting them |

Checkout and cart-creation rate limits are code options, off by default: enable
`checkoutRateLimit` and `cartCreationRateLimit` in `createCommerceApp` only after `TRUST_PROXY` is
right, or every customer shares the proxy's address. Login (10 failures / 15 min), registration
(5 / hour) and password-reset (5 / hour) limits are on by default.

## 3. Health endpoints

System routes are served at the root regardless of `API_BASE_PATH`.

| Endpoint | Touches DB | 200 | 503 | Use for |
|---|---|---|---|---|
| `GET /livez` | no | `{"status":"ok"}` | never | Liveness. A database outage must not restart app containers |
| `GET /readyz` | yes | `{"status":"ready"}` | `shutting_down`, `migrations_pending` (with the list), `database_unreachable` | Readiness / load balancer membership |
| `GET /health` | yes | `{"status":"ok","database":"ok"}` | standard error body, `SERVICE_UNAVAILABLE` | Backward-compatible check, uptime monitors |
| `GET /metrics` | no | Prometheus text | 401 without `Authorization: Bearer $METRICS_TOKEN` when a token is set | Scraping |
| `GET /openapi.json` | no | OpenAPI 3.1 | | Clients, docs |

Kubernetes sketch:

```yaml
livenessProbe:  { httpGet: { path: /livez,  port: 3000 }, periodSeconds: 15 }
readinessProbe: { httpGet: { path: /readyz, port: 3000 }, periodSeconds: 5, failureThreshold: 2 }
lifecycle:
  preStop: { exec: { command: ["sleep", "10"] } }   # see section 9
terminationGracePeriodSeconds: 30                   # > preStop + SHUTDOWN_TIMEOUT_MS + worker cycle
```

The Docker image's `HEALTHCHECK` already uses `/livez`.

## 4. Deploying a release

1. Read `CHANGELOG.md` for the target version, especially "Breaking changes" and upgrade notes.
2. Build the image (`docker build .` or your pipeline). The build runs `tsc`; the runtime image holds
   `dist/` and production dependencies and runs as the `node` user.
3. **Run migrations as a one-off job before rolling out** (section 5). New instances started before
   this stay out of rotation (`/readyz` is 503 `migrations_pending`), but their background workers do
   start and will log errors against the old schema.
4. Roll out instances. Each one runs module and plugin `onStart` hooks, starts listening, then starts
   its worker.
5. Verify: `/readyz` is `ready` on every instance; 5xx rate and p99 latency are flat (section 6);
   the outbox backlog drains (section 12).
6. Rollback: deploy the previous image. Migrations are forward-only, so a rollback is safe only if the
   release's migrations were additive (section 5). Old code ignores tables and columns it does not
   know.

Rolling-deploy caveats from the at-least-once design:

- Events: listener completion is tracked by registration index. If a release adds, removes or
  reorders `extensions.on(...)` calls for an event, events that are mid-retry may skip or repeat a
  listener, and an old instance can deliver an event without a listener that only exists in the new
  version. For such releases, deploy when the retry backlog is empty and keep the rollout short.
- Jobs: a job defined only in the new version can be claimed by an old instance, fail with
  "No handler is defined", and use up its attempts (about 2.5 minutes with the default 5). Replay it
  if it died (section 12).

## 5. Migrations

- Migrations are code: each module and plugin carries a list of `{ id, up }` SQL scripts. Applied ids
  are recorded in `schema_migrations`.
- Run them with the store's `migrate.js` (the CLI template builds the app with the same plugins, so
  plugin tables such as `1100_coupons` are created) or `await app.migrate()`. The repository's
  `npm run migrate` / `dist/migrate.js` applies only the runtime and core module migrations; a server
  with plugins that have migrations stays at `migrations_pending` if only that script ran.
- Concurrency: the runner takes advisory lock `727274`; a second runner waits, then finds nothing to
  do. Safe to run from every deploy.
- Each migration runs in its own transaction and is recorded atomically. A failure rolls back that
  migration only and stops; fix forward with a new migration.
- Timeouts: `app.migrate()` uses the app pool, so `DB_STATEMENT_TIMEOUT_MS` (default 15 s) applies and
  can cancel a long migration (`57014`). Run the migration job with `DB_STATEMENT_TIMEOUT_MS=0`.
  `dist/migrate.js` builds its own pool without a statement timeout.
- `CREATE INDEX CONCURRENTLY` cannot run inside the runner (it wraps every migration in a
  transaction). For a large table, create the index manually with `CONCURRENTLY` first, then ship a
  migration using `CREATE INDEX IF NOT EXISTS`.
- Table-rewriting changes (`ALTER COLUMN ... TYPE`, as in `0910`/`0911`) take an exclusive lock for the
  whole rewrite. Schedule them in a quiet window; consider `SET lock_timeout` at the top of the SQL.

### Zero-downtime changes: expand, then contract

`/readyz` only checks the migrations the running code knows about. Old instances stay ready after new
migrations are applied; new instances become ready only once their migrations exist. This supports
expand/contract:

1. **Expand** (release N): add nullable columns or new tables, backfill in batches, add constraints
   `NOT VALID` and `VALIDATE` them separately. Old code keeps working.
2. **Migrate code** (release N or N+1): read and write the new shape.
3. **Contract** (a later release, after no running version reads the old shape): drop old columns or
   constraints.

Never rename or drop a column in the same release that stops using it, and never edit an applied
migration (`CONTRIBUTING.md`).

## 6. Monitoring and alerts

Metrics (all per instance; counters reset on restart, so always use `rate()` / `increase()`):

| Metric | Labels |
|---|---|
| `http_requests_total` | `method`, `route` (pattern, `unmatched` for 404s), `status` |
| `http_request_duration_seconds` (histogram, 5 ms to 10 s buckets) | `method`, `route` |
| `db_pool_connections` | `state` = `total`, `idle`, `waiting` |
| `outbox_events_total` | `event`, `result` = `delivered`, `retry`, `dead` |
| `jobs_total` | `name`, `result` = `done`, `retry`, `dead` |
| `process_resident_memory_bytes`, `process_uptime_seconds`, `nodejs_eventloop_lag_p99_seconds` | |

Suggested rules (tune thresholds to your traffic):

```yaml
groups:
  - name: maa
    rules:
      - alert: MaaHigh5xxRate
        expr: sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) > 0.01
        for: 5m
      - alert: MaaSlowP99
        expr: histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{route!="unmatched"}[5m]))) > 1
        for: 10m
      - alert: MaaDbPoolSaturated
        expr: max(db_pool_connections{state="waiting"}) > 0
        for: 5m
      - alert: MaaOutboxDeadEvents
        expr: sum(increase(outbox_events_total{result="dead"}[15m])) > 0
      - alert: MaaDeadJobs
        expr: sum(increase(jobs_total{result="dead"}[15m])) > 0
      - alert: MaaEventLoopLag
        expr: max(nodejs_eventloop_lag_p99_seconds) > 0.2
        for: 5m
      - alert: MaaInstanceDown
        expr: up{job="maa"} == 0
        for: 2m
```

Useful ad-hoc queries:

- p99 by route: `histogram_quantile(0.99, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))`
- Events being retried: `sum by (event) (rate(outbox_events_total{result="retry"}[10m]))`
- Brute force or abuse: `sum(rate(http_requests_total{status="429"}[5m]))`
- Contention: `sum(rate(http_requests_total{status="503"}[5m]))` (deadlock retries exhausted, query
  timeouts, database unreachable)

There is no gauge for the outbox backlog or for the number of dead rows (gauges are collected
synchronously and cannot query the database). Check them with SQL (section 12), or from a monitoring
query against the database:

```sql
SELECT count(*) AS pending, coalesce(extract(epoch FROM now() - min(created_at)), 0) AS oldest_seconds
  FROM outbox_events WHERE processed_at IS NULL AND dead_at IS NULL;
```

## 7. Logs

With `LOG_FORMAT=json` every line is one JSON object: `time`, `level`, `msg`, `requestId`, plus fields.
The per-request line has `method`, `path` (never the query string), `route`, `status`, `durationMs`.
Server errors (5xx) add an `Unhandled error` line with `route`, `message` and `stack`. Keys that look
like passwords, tokens, secrets, API keys, cookies or signatures are written as `[REDACTED]`.

Background work logs carry `eventId` or `jobId` instead of a request id. The worker logs a failing
cycle at most once per minute.

## 8. Rotating secrets

Previous values are accepted alongside current ones. Each `*_PREVIOUS` variable takes a
comma-separated list, and every entry must also be 32+ characters.

### `OWNER_API_KEY`

1. Deploy with `OWNER_API_KEY=<new>` and `OWNER_API_KEY_PREVIOUS=<old>`. Both keys work on every
   instance once the rollout finishes.
2. Switch every client (admin tools, scripts, integrations) to the new key.
3. Deploy with `OWNER_API_KEY_PREVIOUS` empty. The old key now gets 401.

If the key leaked, skip step 1: deploy the new key alone and update clients immediately.

### `AUTH_TOKEN_SECRET`

The first secret signs new tokens; all listed secrets verify. A one-step swap during a rolling deploy
would let new instances issue tokens that old instances reject, so rotate in two deploys:

1. Deploy `AUTH_TOKEN_SECRET=<old>`, `AUTH_TOKEN_SECRET_PREVIOUS=<new>`. Every instance now accepts
   the new secret but still signs with the old one.
2. Deploy `AUTH_TOKEN_SECRET=<new>`, `AUTH_TOKEN_SECRET_PREVIOUS=<old>`. New tokens use the new secret;
   existing tokens keep working.
3. After the token lifetime (`tokenTtlSeconds`, default 7 days), deploy with
   `AUTH_TOKEN_SECRET_PREVIOUS` empty.

If the secret leaked: tokens are bound to server-side sessions, so a forger still needs a live session
id (ADR 0006). Rotate immediately without keeping the old secret (everyone is signed out), and if you
suspect sessions were exposed, revoke them all:

```sql
UPDATE auth_sessions SET revoked_at = now() WHERE revoked_at IS NULL;
```

## 9. Graceful shutdown

`installShutdownHandlers(app, { timeoutMs: SHUTDOWN_TIMEOUT_MS })` handles `SIGTERM` and `SIGINT`:

1. `/readyz` starts answering 503 `shutting_down`; responses carry `Connection: close`.
2. The server stops accepting connections and closes idle keep-alive connections.
3. In-flight requests get up to `SHUTDOWN_TIMEOUT_MS` (default 10 s); then remaining connections are
   cut.
4. The background worker finishes its current cycle and stops.
5. Plugin `onStop` hooks run in reverse order (errors logged), then module `onStop` hooks, then the
   pool closes. Exit code 0.

A second signal exits immediately with code 1.

Notes:

- Set `SHUTDOWN_DELAY_MS` (for example `5000`, longer than one readiness probe period) so `/readyz`
  turns 503 and the load balancer stops routing *before* the listener closes. Without it, readiness
  and the listener change at the same moment; a Kubernetes `preStop` sleep achieves the same.
- The grace period must exceed `SHUTDOWN_TIMEOUT_MS` plus a worker cycle. A job running longer is
  killed; its 300 s lease (60 s for events) expires and another instance runs it again.
- Run node as PID 1 or behind an init that forwards signals. The Dockerfile uses exec form
  (`CMD ["node", ...]`) for this; `docker-compose.yml` sets `stop_grace_period: 15s`.

## 10. When the database is down

What you will see:

- `/livez` stays 200 (do not restart app containers for a database problem).
- `/readyz` returns 503 `database_unreachable`; `/health` returns 503 `SERVICE_UNAVAILABLE`.
- API requests fail. Connection errors (refused, timed out after `DB_CONNECTION_TIMEOUT_MS`) are not
  translated, so clients get **500 `INTERNAL_ERROR`**, not 503. PostgreSQL error codes that reach
  `translateDbError` are mapped: statement timeout (`57014`) is 503 `QUERY_TIMEOUT`, too many
  connections (`53300`) is 503 when raised by a repository query (when raised while
  `withTransaction` opens its connection it is a 500).
- Logs show `Idle database connection failed` and `Background worker cycle failed` (once a minute).

What to do:

1. Confirm from a host that can reach the database: `pg_isready -h <host>`, then
   `psql "$DATABASE_URL" -c 'SELECT 1'`.
2. Check the usual causes: failover in progress, connection limit (`SELECT count(*) FROM
   pg_stat_activity;` versus `max_connections`), disk full, expired credentials.
3. Do not restart app instances in a loop; the pool reconnects on its own once the database answers.
4. After recovery: `/readyz` returns `ready` without action. Check that the outbox backlog drains,
   look for refunds stuck in `pending` (section 12), and expect clients to retry. Nothing committed
   is lost, and events for committed changes are still in the outbox. Failed requests released their
   idempotency keys; a key left "in progress" by a crashed instance is taken over after 60 seconds.

## 11. Investigating a customer complaint

Every response has an `X-Request-Id` header, and every error body has `error.requestId`. The Maa
Store shows the first 8 characters as a reference number. A proxy may supply its own id in
`X-Request-Id` (letters, digits, `._:-`, up to 128 characters); otherwise Maa generates a UUID.

1. Get the reference (or the full id) and an approximate time.
2. Search the logs: `requestId` equal to, or starting with, the reference. In `pretty` format the line
   ends with `req=<first 8 characters>`.
3. The request line gives route, status and duration. A 5xx has an `Unhandled error` line with the
   stack. A 4xx is explained by the response's `error.code` and `details`.
4. For owner or staff actions, the audit log has the same id:
   ```sql
   SELECT at, actor_type, actor_id, actor_role, action, path, status_code, ip, body
     FROM audit_log WHERE request_id LIKE '3f2a9c1e%' ORDER BY at;
   ```
   or `GET /audit-log?actorId=...&action=PATCH%20/orders` with `audit:read`.
5. For an order, the timeline shows every status, payment, refund and delivery change with its actor:
   ```sql
   SELECT at, type, from_value, to_value, actor_type, actor_id, note
     FROM order_events WHERE order_id = '<order id>' ORDER BY at, id;
   ```
6. Event side effects (emails, notifications) are logged by the worker with the `eventId`; find the
   event with `SELECT * FROM outbox_events WHERE payload->'order'->>'id' = '<order id>';`.

## 12. Dead events, dead jobs and stuck work

Columns are defined in `src/runtime/migrations.ts`.

### Outbox

```sql
-- Backlog and age
SELECT count(*) FILTER (WHERE attempts > 0) AS retrying, count(*) AS pending, min(created_at) AS oldest
  FROM outbox_events WHERE processed_at IS NULL AND dead_at IS NULL;

-- Dead events
SELECT id, event, attempts, completed_listeners, last_error, created_at, dead_at
  FROM outbox_events WHERE dead_at IS NOT NULL ORDER BY dead_at DESC LIMIT 50;

-- Inspect one (payload is NULL for sensitive events)
SELECT event, payload, sensitive FROM outbox_events WHERE id = 1234;
```

Replay after fixing the cause. `completed_listeners` is kept, so listeners that already succeeded are
not called again; the event gets a fresh set of 10 attempts:

```sql
UPDATE outbox_events
   SET dead_at = NULL, attempts = 0, available_at = now(), locked_until = NULL, last_error = NULL
 WHERE id = 1234 AND dead_at IS NOT NULL;
```

Do not replay sensitive events (`sensitive = true`): their payload was erased, and the listener would
receive `null`. For a password reset, the customer requests a new code. Do not replay an event if the
listener order changed since it died (section 4); deliver its effect by hand instead. Dead events are
deleted 30 days after `dead_at`, processed ones 7 days after `processed_at`.

### Jobs

```sql
SELECT id, name, attempts, max_attempts, last_error, run_at, dead_at, payload
  FROM jobs WHERE dead_at IS NOT NULL ORDER BY dead_at DESC LIMIT 50;

-- Replay one
UPDATE jobs SET dead_at = NULL, attempts = 0, run_at = now(), locked_until = NULL, last_error = NULL
 WHERE id = 5678 AND dead_at IS NOT NULL;

-- Currently leased (a crashed instance's lease expires on its own after 300 s)
SELECT id, name, attempts, locked_until FROM jobs WHERE locked_until > now();
```

Dead runs of recurring jobs (`system.cleanup`, `orders.releaseExpiredHolds`, `cart.cleanupAbandoned`)
usually need no replay: the next time bucket enqueues a fresh run. Investigate the error anyway; a
hold-release job that keeps dying leaves unpaid orders holding stock.

### Refunds stuck in `pending`

A refund reserves its amount in `orders.refunded_total`, calls the provider outside any transaction,
then completes. A crash between those steps leaves the refund `pending` with the amount reserved:

```sql
SELECT r.id, r.order_id, r.amount, r.created_at, o.payment_method
  FROM refunds r JOIN orders o ON o.id = r.order_id
 WHERE r.status = 'pending' AND r.created_at < now() - interval '15 minutes';
```

Check the provider's records. If no money moved, release the reservation in one transaction. A
refund also reserves its restock quantities (`order_items.restocked_quantity`) before the provider
call, so release those too (`refunds.restock` lists them):

```sql
BEGIN;
UPDATE refunds SET status = 'failed', completed_at = now() WHERE id = '<refund id>' AND status = 'pending';
UPDATE orders SET refunded_total = refunded_total - <amount>, updated_at = now() WHERE id = '<order id>';
UPDATE order_items i SET restocked_quantity = i.restocked_quantity - (r.line->>'quantity')::int
  FROM (SELECT jsonb_array_elements(restock) AS line FROM refunds WHERE id = '<refund id>') r
 WHERE i.order_id = '<order id>' AND i.product_id = (r.line->>'productId')::uuid
   AND i.variant_id IS NOT DISTINCT FROM (r.line->>'variantId')::uuid;
COMMIT;
```

If the provider did refund, record it with the provider reference and adjust payment status and
stock deliberately; there is no automated reconciliation.

## 13. Backups and restore

- One database holds everything, so one backup is a consistent snapshot of orders, stock, sessions,
  pending events and jobs.
- Use continuous archiving with point-in-time recovery (managed provider PITR, pgBackRest or WAL-G),
  plus a periodic `pg_dump -Fc` kept off-site. Encrypt backups: they contain personal data and
  password hashes.
- Secrets are not in the database. Keep `OWNER_API_KEY`, `AUTH_TOKEN_SECRET` and plugin secrets in
  the secret manager, which needs its own backup.
- Restore drill, at least quarterly: restore into a fresh database, point a staging instance at it,
  run the migration job (it should apply nothing), check `/readyz`, place a test order.
- After restoring to an earlier point in time:
  - sessions created after that point are gone: those users sign in again;
  - events delivered after the backup but before the incident are delivered again (listeners must be
    idempotent; customers may receive a duplicate message);
  - payments and refunds the provider processed after that point are unknown to Maa: reconcile with
    the provider's records.
- Retention: `system.cleanup` removes idempotency keys after 24 hours, expired rate-limit rows,
  sessions one day after expiry or 30 days after revocation, processed events and finished jobs after
  7 days, dead ones after 30 days, and expired reset codes after a day. `audit_log`, orders and
  `order_events` are never deleted; plan for their growth and any legal retention limit on personal
  data.
