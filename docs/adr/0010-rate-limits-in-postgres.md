# 0010. Rate limits stored in PostgreSQL

- Status: Accepted
- Since: 1.0.0

## Context

0.1.0 kept rate-limit counters in process memory (`FailureLimiter`). Behind a load balancer with two
instances an attacker got twice the attempts, and a restart reset every counter. Limits that count
every attempt (registration) were also exposed to a race once the store became asynchronous: ten
concurrent requests could all pass the check before any of them was recorded.

## Decision

- A `Limiter` interface (`src/engine/rate-limiter.ts`): `retryAfter`, `recordFailure`,
  `recordAttempt`, `reset`, and `consume` (record and decide in one atomic step).
- `PostgresLimiter` (`src/runtime/rate-limit.ts`) over `rate_limits(key, count, reset_at)`: a fixed
  window that starts with the first attempt, updated by a single
  `INSERT ... ON CONFLICT DO UPDATE` statement, timed by the database clock (`now()`), so instance
  clock skew does not matter.
- It is the default store (`rateLimitStore: "postgres"`); `"memory"` keeps the old
  `FailureLimiter` for single-instance setups and tests.
- Limits and defaults (`src/app.ts`):

| Limit | Key | Default | Style |
|---|---|---|---|
| Login (customers and staff, separate prefixes) | per IP and per email | 10 failures / 15 min | check before scrypt, record failures after |
| Registration | per IP | 5 / hour | `consume` |
| Password reset request | per IP and per email | 5 / hour | `consume` |
| Checkout | per IP | off | `consume` |
| Cart creation | per IP | off | `consume` |

- A successful login clears the per-email counter, not the per-IP one.
- Checkout and cart-creation limits are off by default: behind a proxy without `trustProxy`, every
  customer has the proxy's address and the limit would throttle the whole store.
- `system.cleanup` deletes expired rows hourly.

## Consequences

- Counters are shared by all instances and survive restarts
  (`tests/integration/multi-instance.test.ts`).
- `consume` is atomic: ten simultaneous registrations from one IP create exactly five accounts
  (`tests/integration/registration-rate-limit.test.ts`).
- Blocked login attempts cost a single query and no password hashing.
- One or two extra statements per guarded request.
- The login limit is check-then-record, so a parallel burst can exceed the threshold by up to the
  burst's concurrency before the counter catches up.
- A fixed window allows up to twice the limit across a window boundary.
- Unlike the memory store (`maxKeys`), the table has no size bound between hourly cleanups; an
  attacker cycling keys grows it.
- If the database is down, guarded routes fail rather than skip the limit.

## Alternatives considered

- **Redis counters.** The usual choice; a second system (ADR 0002).
- **Per-instance memory.** Kept as an option, wrong for multiple instances.
- **Sliding window or token bucket.** More precise, more complex SQL; the fixed window is enough
  for brute-force protection.
- **Proxy-level limits (nginx `limit_req`).** Complementary: recommended for raw request floods,
  but the proxy cannot see per-email failure counts.
