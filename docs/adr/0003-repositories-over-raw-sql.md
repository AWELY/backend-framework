# 0003. Repositories over hand-written SQL, no ORM

- Status: Accepted
- Since: 0.1.0

## Context

The correctness of a commerce backend depends on database behaviour that must be visible in review:
`SELECT ... FOR UPDATE` on the cart during checkout, conditional `UPDATE ... WHERE quantity + $2 >= 0`
for stock, `INSERT ... ON CONFLICT`, `FOR UPDATE SKIP LOCKED` for queues, `COUNT(*) OVER()` for
paging, CHECK constraints that reject an order whose total does not add up. ORMs tend to hide
exactly these.

## Decision

- SQL is written by hand and executed with `pg`. Every value goes through `$n` placeholders.
- `Repository<TEntity, TRow>` (`src/db/repository.ts`) gives each table `findById`, `findAll`,
  `findPage` (items and total in one query with `COUNT(*) OVER()`), `delete` and `updateColumns`
  (partial updates, optional version check, ADR 0013). Subclasses supply the table name and a
  `toEntity` mapping from snake_case rows to camelCase API objects.
- Table names, `ORDER BY` clauses and column names are constants in the subclass, never request
  input. Sort options are enums mapped to fixed SQL (`SORTS` in `products.repository.ts`); search
  input escapes `%`, `_` and `\` before `ILIKE`.
- Repositories accept a `Queryable` (the pool or a transaction client), so the same class works
  inside `withTransaction` and outside it.
- Operations spanning several tables live in services (`orders.service.ts`, `delivery.service.ts`).
- Database errors pass through `translateDbError` (`src/db/errors.ts`): unique violation is 409,
  foreign key 400, check violation 400, deadlock 503, and so on. PostgreSQL's `detail` text is never
  sent to the client because it can echo stored values.

## Consequences

- Every query is readable in the file that runs it; locking and constraints are reviewed as code.
- One runtime database dependency (`pg`), no ORM migration engine or lazy loading.
- Row mapping is boilerplate, and SQL is not checked against the schema at compile time. Tests run
  on a real PostgreSQL to compensate (`CONTRIBUTING.md`).
- N+1 queries must be avoided by hand (order lists load all items with `order_id = ANY($1)`).
- Dynamic filters are assembled by hand, which needs care to keep identifiers out of user input.

## Alternatives considered

- **Prisma, TypeORM, Sequelize.** Hide locking semantics, bring their own migration systems and a
  large dependency tree.
- **Query builders (Knex, Kysely).** Kysely's typed queries are attractive; rejected to keep the
  dependency budget, may be revisited if SQL-schema drift becomes a real source of bugs.
- **Stored procedures.** Move logic out of TypeScript tests and reviews; no gain at this scale.
