# 0004. An in-house validator instead of Zod

- Status: Accepted
- Since: 0.1.0 (v2 with nested objects, arrays, nullable and query coercion in 1.0.0)

## Context

Every request body, query string and route parameter must be checked before a handler runs. The
requirements are specific to this API:

- Unknown fields are rejected at every level, so a client cannot slip `role`, `price` or
  `customerId` into a body (mass assignment).
- All problems are reported in one 400, each with its full path (`restock[1].quantity`).
- `optional` (may be absent) and `nullable` (null means "clear this field") are distinct, so
  `PATCH /products/:id {"categoryId": null}` can remove a category.
- Query strings and route parameters are strings and need coercion (`?limit=20`), while unknown
  query keys (`utm_source`) must be ignored, not rejected.
- The handler should receive a typed value inferred from the schema, without casts.
- The same schema must generate the OpenAPI document.

## Decision

`src/engine/validation.ts` (about 290 lines, no dependency):

- Rules: `string` (minLength, maxLength, pattern, oneOf), `number` (min, max, integer meaning
  safe integer), `boolean`, `object` (nested schema), `array` (items, minItems, maxItems); every rule
  takes `optional`, `nullable` and `description`.
- `validate(schema, input, { partial })` returns a new object with schema fields only, or throws one
  `ValidationError` whose `details` lists every `{ field, message }`.
- `validateQuery()` coerces numbers and booleans, reads repeated keys into arrays and ignores unknown
  keys.
- `Infer<S>` derives the TypeScript type from a schema.
- `withInput(spec, handler)` (`src/middleware/validate.ts`) validates body, query and params
  together, merges their issues into one 400, passes typed values to the handler, and attaches the
  spec to the route for `generateOpenApi()`. `npm run lint` forbids `req.body as` casts in modules
  and plugins.
- Field names are checked with `Object.hasOwn`, so `constructor` or `__proto__` are not mistaken for
  schema fields (0.1.0 used `in` and let them through).
- For backward compatibility, `null` on a non-nullable field still means "not sent".

## Consequences

- Zero dependencies, behaviour shaped exactly to the error contract, and OpenAPI that cannot drift
  from validation (`npm run openapi:check` in CI).
- Fuzzed: any JSON value either validates or throws `ValidationError`
  (`tests/unit/validation-v2.test.ts`).
- Limited expressiveness: no unions, no custom refinements or transforms, no date type. Cross-field
  rules live in handlers (for example, a percent coupon must be at most 100), and dates are strings
  matched by a pattern and then parsed by the handler that needs them.
- We maintain it, and contributors cannot reuse Zod knowledge.

## Alternatives considered

- **Zod.** The default choice in the ecosystem. Rejected for the dependency budget, the extra
  package needed for OpenAPI, and the work of mapping its errors to our `details` format.
- **Ajv with JSON Schema.** Standard and fast, and OpenAPI would be nearly free; schemas are verbose
  and type inference needs extra tooling. The closest alternative.
- **Joi, Yup.** No first-class TypeScript inference.

Revisit if bodies need discriminated unions or the schema count grows enough that the missing
features cost more than a dependency.
