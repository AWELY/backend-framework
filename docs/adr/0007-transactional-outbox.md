# 0007. Transactional outbox for events

- Status: Accepted
- Since: 1.0.0

## Context

In 0.1.0, checkout called `ExtensionRegistry.emit("order.created")` after `COMMIT`, inside the
request:

- if the process stopped between `COMMIT` and `emit`, the event was lost for good (no confirmation
  message, no notification to the shop);
- a slow listener (an email taking 3 seconds) delayed the checkout response by 3 seconds;
- a listener that failed was never retried;
- with several instances there was no coordination at all.

## Decision

Events are rows in `outbox_events`, written in the transaction that made the change, and delivered
later by a background worker (`src/runtime/outbox.ts`, `src/runtime/worker.ts`).

- `events.publish(client, event, payload, { sensitive })` inserts the event on the transaction's
  connection; it commits or rolls back with the data. `events.notify()` after `COMMIT` asks the
  local worker for an immediate cycle instead of waiting for the next poll.
- Every instance runs one `BackgroundWorker` (poll interval 1 s by default, `workers: false` turns it
  off). A cycle claims up to 20 ready events with
  `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`, setting a 60 s lease
  (`locked_until`) and incrementing `attempts`.
- Listeners for the event run in registration order. Success is recorded per listener in
  `completed_listeners` (the listener's index), so a retry calls only the listeners that failed.
- Retry with backoff `min(3600, 2^attempts)` seconds. After 10 attempts the event is dead
  (`dead_at`, `last_error`), an error is logged and `outbox_events_total{result="dead"}` increments.
- Sensitive events (the password reset code) have their payload set to `NULL` once delivered or dead.
- Listeners receive `EventMeta`: `id`, `event`, `version` (currently 1), `occurredAt`, `attempt`.
  Fields ending in `At` are revived to `Date` objects.
- `ExtensionRegistry.emit()` remains for older plugins that fire their own events inline; the
  framework itself no longer uses it.

## Consequences

- No lost events and no dual write: an order exists if and only if its `order.created` row exists.
- Checkout responds without waiting for listeners; a failing listener cannot break a request.
- Delivery is at least once. A listener can run twice for one event (process stops after the
  listener succeeded but before the result was saved, or a listener outlives its 60 s lease), so
  listeners must be idempotent, keyed on `meta.id`.
- No ordering guarantee across events; two instances may deliver consecutive events in parallel.
- Latency is milliseconds with `notify()`, at most one poll interval otherwise.
- Payload semantics changed: `order.created` now carries the order as committed, before payment
  starts; the payment result arrives in `order.paymentChanged`.
- Listener identity is its registration index. Changing the order or number of listeners for an
  event between deploys can misattribute completion for events that are mid-retry, and an old
  instance may deliver an event without a listener that only exists in the new version
  (`docs/RUNBOOK.md`).
- The table grows; `system.cleanup` deletes processed events after 7 days and dead ones after 30.

## Alternatives considered

- **Inline emit after commit (0.1.0).** Loses events on crash, couples latency to listeners.
- **A message broker.** Still needs an outbox to avoid dual writes, plus a second system (ADR 0002).
- **`LISTEN/NOTIFY` alone.** Not durable; a notification sent while no one listens is gone.
- **Change data capture (logical decoding, Debezium).** Durable, but heavy infrastructure for one store.
- **pg-boss or graphile-worker.** Mature, but a dependency with its own schema and conventions for a
  feature that fits in under 200 lines here.
