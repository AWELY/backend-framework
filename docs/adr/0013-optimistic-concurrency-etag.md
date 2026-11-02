# 0013. Optimistic concurrency with version and ETag

- Status: Accepted
- Since: 1.0.0

## Context

Two staff members open the same product, both edit, both save: the second save silently overwrites
the first (lost update). A database lock cannot span the minutes between reading a form and
submitting it.

## Decision

- `products` and `categories` have a `version INTEGER` column (migrations `0930_categories_version`,
  `0931_products_version`). Their repositories pass `versioned = true` to `Repository`, so every
  update runs `version = version + 1` (`src/db/repository.ts`).
- `GET`, `POST` and `PATCH` responses for these resources carry `ETag: "<version>"`.
- `PATCH` and `DELETE` accept `If-Match: "<version>"` (a weak `W/"<version>"` is accepted; `*` means
  any version). The write adds `AND version = $n`. If no row matched but the row exists, the response
  is 412 `PRECONDITION_FAILED` with `details.currentVersion`; if it does not exist, 404.
- A malformed `If-Match` is 412: the client asked for a condition the server cannot check.
- `If-Match` is optional; without it the write behaves as before (ADR 0012).
- Routes that accept `If-Match` are marked `conditional` in their `withInput` spec and documented as
  such in OpenAPI.

## Consequences

- Lost updates on the catalogue are detected without holding locks
  (`tests/integration/hardening.test.ts`).
- Cost: one integer column, plus one extra `SELECT` only when a conditional write misses.
- Only products and categories are versioned. Orders rely on row locks and state machines instead
  (an invalid transition is 409); variants, coupons and staff accounts are last-writer-wins.
- Clients that do not send `If-Match` keep last-writer-wins semantics.
- The ETag is a version number, not a content hash. `If-None-Match` / 304 is not implemented.

## Alternatives considered

- **Pessimistic locks.** Cannot be held across HTTP requests.
- **Comparing `updated_at`.** Timestamp precision and clock issues; a counter is unambiguous.
- **Content-hash ETags.** Would also enable 304 responses, but cost a hash per response and add
  nothing for conflict detection.
- **Requiring `If-Match`.** Safer, but breaks every existing client.
