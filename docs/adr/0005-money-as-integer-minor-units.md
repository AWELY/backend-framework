# 0005. Money as integer minor units in BIGINT

- Status: Accepted
- Since: 0.1.0 (integers); 1.0.0 (BIGINT, currency column)

## Context

Binary floating point cannot represent most decimal amounts (`0.1 + 0.2 = 0.30000000000000004`),
and money does not tolerate rounding drift. The default currency, the Libyan dinar, has three decimal
places (1 dinar = 1000 dirhams).

0.1.0 stored amounts as `INTEGER` minor units. `INTEGER` stops at 2,147,483,647, about 2.1 million
dinars in dirhams: enough for one price, not for order totals or a year of sales. Moving to `BIGINT`
raises a second problem: `pg` returns `int8` as a string by default, which would turn `"price": 70000`
into `"price": "70000"` in the API.

## Decision

- Every amount is an integer in the smallest unit of the store currency: prices, subtotals,
  shipping, adjustments, totals, refunds, coupon values, cash collected. The validator enforces
  `integer: true` (safe integers only).
- Money columns are `BIGINT` (migrations `0910_products_price_bigint`, `0911_orders_money_bigint`;
  newer tables are created with `BIGINT`).
- The pool installs a type parser for `int8` (`src/db/connection.ts`) that returns a JavaScript
  number and throws `RangeError` above `Number.MAX_SAFE_INTEGER` (2^53 - 1). A loud error beats a
  silently wrong amount. The parser is per pool, not a global `pg` setting.
- One currency per store: `CURRENCY` (ISO 4217, default `LYD`), copied onto each order in
  `orders.currency CHAR(3)`.
- The database enforces arithmetic: `total = subtotal + shipping_cost + adjustments_total` and
  `line_total = unit_price * quantity` (CHECK constraints, migration 0920), and
  `0 <= refunded_total <= total`.
- Plugins return integer amounts; the orders service rejects non-integer or negative results from
  shipping providers and price adjusters. Rounding is the plugin's policy: `percentageTax` uses
  `Math.round`, `coupons` uses `Math.floor` for percent discounts.

## Consequences

- No rounding drift in sums; amounts round-trip as JSON numbers.
- Clients format amounts themselves (divide by 1000 for LYD). The API never sends decimals.
- `COUNT(*)` and any other `int8` read through the framework's pool are numbers, not strings.
- Products carry no currency of their own. Changing `CURRENCY` on a live store relabels every
  existing price without converting it; treat it as fixed after launch.
- Migrations 0910 and 0911 rewrite their tables under an exclusive lock; on a large existing
  database, run them in a quiet window.

## Alternatives considered

- **`NUMERIC` columns.** Exact, but `pg` returns strings and JavaScript has no decimal type; every
  calculation would need a decimal library.
- **Floating-point numbers.** Rejected outright.
- **Strings in the API.** Safe for any size, but would break every existing client.
- **Multi-currency per product.** Out of scope for a single-store framework.
