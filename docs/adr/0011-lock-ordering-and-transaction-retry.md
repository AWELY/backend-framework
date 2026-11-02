# 0011. Fixed lock ordering and automatic transaction retry

- Status: Accepted
- Since: 1.0.0

## Context

Measured before the fix: 60 concurrent checkouts over two products, half the carts in order A then
B and half B then A, failed 51 to 54 times with HTTP 500 "deadlock detected" (PostgreSQL 40P01).
Each checkout decremented stock rows in cart order, so two transactions could each hold one row and
wait for the other's. Cancellation and refund restocking had the same pattern.

## Decision

1. **One lock order for stock.** Every transaction that touches several stock rows sorts its lines
   with `byStockLockOrder` (`src/modules/inventory/inventory.repository.ts`: product id, then variant
   id) before the conditional updates. Used by checkout, cancellation (`applyStatus`) and refund
   restock. Within checkout the order is: cart row (`FOR UPDATE`), then stock rows in fixed order,
   then the order insert. Status and payment changes lock the order row first.
2. **Retry on transient conflicts.** `withTransaction` (`src/db/transaction.ts`) re-runs the whole
   work function after `ROLLBACK` on 40P01 (deadlock) and 40001 (serialization failure): 3 retries by
   default, with jittered exponential backoff (`10 * 2^attempt` ms plus up to 20 ms). When retries
   are exhausted the client gets 503 `TRANSACTION_CONFLICT` with `Retry-After: 1`.
3. **No external side effects inside a transaction.** Because work can run more than once, payment
   initiation and provider refunds happen outside transactions (after `COMMIT`, or between the two
   transactions of a refund).
4. Related timeouts are explicit: `statement_timeout` cancellations become 503 `QUERY_TIMEOUT`;
   `lock_not_available` and `too_many_connections` become 503.

## Consequences

- 500 concurrent checkouts over the same two products in opposite orders: 0 errors, and
  `initial stock = remaining + sold` (`tests/integration/concurrency.test.ts`, the Phase 1 exit test).
- Concurrent cancellations restock exactly once; the last items are never oversold.
- Any new code path that locks several stock rows must use `byStockLockOrder`. This is a convention
  enforced by review and tests, not by lint.
- Work functions must be safe to re-run from scratch; custom code that called external services
  inside `withTransaction` must move those calls out (listed in `CHANGELOG.md`).
- Retries add load under heavy contention; the cap bounds it.
- Lock order across other tables is by convention. The coupons plugin reads coupons outside the
  checkout transaction (its redemption limit is therefore soft; see `src/plugins/coupons.ts`).

## Alternatives considered

- **SERIALIZABLE isolation with retries.** Correct but produces far more retries for this workload.
- **`NOWAIT` or `SKIP LOCKED` on stock rows.** Fails fast instead of waiting; worse for buyers.
- **Advisory locks per product.** Same ordering problem, plus lock bookkeeping.
- **A single checkout queue.** Removes concurrency and adds latency.
