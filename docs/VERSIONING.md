# Versioning and compatibility policy

Maa follows [Semantic Versioning 2.0.0](https://semver.org/) from 1.0.0. The version in
`package.json` covers the JavaScript API, the HTTP contract, error codes and events together: there
is one version number, not one per surface. 0.x releases carried no compatibility promise.

Changes are recorded in `CHANGELOG.md`. The reasoning behind the additive-first approach is
ADR 0012.

## What is public

1. **The package exports.** Everything exported from `src/index.ts` (`require("maa")`), including
   exported types. Anything reached by a deep import (`maa/dist/...`) is internal and may change in
   any release.
2. **The HTTP contract.**
   - Routes, methods, path parameters and request schemas, as published in `docs/openapi.json`
     (generated from the route schemas; CI fails if it drifts).
   - Response bodies as documented in `docs/API.md`, success status codes, and the bare-array shape of
     list responses.
   - Headers: `X-Request-Id`, `X-Total-Count`, `ETag`, `If-Match`, `Idempotency-Key`,
     `Idempotency-Replayed`, `Retry-After`, `Allow`, and the CORS headers Maa sets.
   - Authentication: `X-Api-Key` for the owner, `Authorization: Bearer <token>` for customers and
     staff, and which permission each route requires.
   - System routes `/health`, `/livez`, `/readyz`, `/metrics`, `/openapi.json` and their responses.
3. **The error contract.** The envelope `{ "error": { "code", "message", "details", "requestId" } }`,
   the HTTP status for each condition, and the values of `ErrorCodes`. For `VALIDATION_FAILED`,
   `details` is an array of `{ field, message }` and the field paths are part of the contract.
   `message` texts are for humans and may change, with one exception kept for existing clients:
   "Invalid or expired token". Codes added by a plugin (for example `INVALID_COUPON`) belong to that
   plugin's contract.
4. **Events.** Event names in `CommerceEvents`, their payload shapes, the `EventMeta` fields, and the
   delivery guarantees (after commit, at least once, unordered).
5. **Extension contracts.** `CommerceModule`, `CommercePlugin`, `ModuleContext`, `ShippingProvider`,
   `PaymentProvider`, `PriceAdjuster`, and the DI tokens exported from `src/index.ts`.
6. **Configuration.** Environment variable names read by `loadConfig()`, the accepted values and
   defaults, and the options of `createCommerceApp()`.
7. **The CLI.** `maa create <name>` and the layout of the generated project.
8. **Migrations.** Released migration ids and their SQL never change (`CONTRIBUTING.md`). Table and
   column layout is not a designed API, but stores run their own SQL against the same database, so
   removing or renaming a table or column is treated as a breaking change.

Supported platforms are part of the contract too: Node.js 24+ and PostgreSQL 15+ for 1.x.

## What each kind of release may contain

| Release | May contain |
|---|---|
| **Patch** (1.0.x) | Bug fixes and security fixes that keep the contract. Documentation. Internal refactors. |
| **Minor** (1.x.0) | Everything a patch may contain, plus additive changes: new exports, routes, optional request fields, response fields, headers, error codes for new conditions, events, payload fields, options with backward-compatible defaults, additive migrations. Deprecations. |
| **Major** (x.0.0) | Breaking changes, listed under "Breaking changes" in `CHANGELOG.md` with upgrade steps. Removal of deprecated APIs. |

Security exception: when keeping old behaviour would leave users exposed, a fix may break the
contract in a minor or patch release. It is then listed under both "Security" and
"Breaking changes" with the reason.

## What counts as breaking

### HTTP

- Removing or renaming a route, changing its method, or moving it under a different path.
- Requiring authentication or a permission that was not required, or changing which role holds a
  permission in `DEFAULT_ROLES` so that a role loses access.
- Making an optional request field required, rejecting input that was accepted (outside the security
  exception), or changing the meaning or unit of a field.
- Removing, renaming or retyping a response field (number to string, array to object), or wrapping a
  bare array in an envelope.
- Changing a success status code (for example 404 to 204), or the status or `code` returned for an
  existing error condition.
- Removing a documented header, or changing default page size or limits.

Not breaking: new response fields, new optional request fields, new routes, new error codes for new
conditions, new headers. **Clients must ignore unknown fields and tolerate unknown enum values in
responses.** Adding a value to a response enum (as `partially_refunded` was added to `paymentStatus`)
is a minor change, called out under "Changed".

### JavaScript and TypeScript

- Removing or renaming an export.
- An incompatible signature change: a new required parameter, a narrower parameter type, a wider
  return type, sync to async (as `issueCustomerToken` became in 1.0.0).
- Changing the type of a `ModuleContext` member, or adding a required member to an interface that
  stores or plugins implement (`PaymentProvider`, `ShippingProvider`, `PriceAdjuster`,
  `CommercePlugin`, `CommerceModule`, `SessionVerifier`, `IdempotencyStore`, `AuditSink`).
- Changing a default in a way that changes behaviour for code that does not pass the option.
- Type-only changes that make previously compiling code fail.

Not breaking: new optional members on implemented interfaces, new members on objects the framework
hands out (`ModuleContext`, `CommerceApp`), new exports.

### Events

- Removing an event or a payload field, changing a field's type or meaning, or weakening delivery
  guarantees. An incompatible payload change also increments `EventMeta.version`.
- Changing when an event fires relative to the transaction or the response (1.0.0 moved listeners
  after commit; that was breaking).

### Configuration, database and runtime

- Renaming or removing an environment variable, adding a required one, or rejecting values that used
  to be accepted.
- A migration that drops or renames tables or columns, or that needs a manual step.
- Raising the minimum Node.js or PostgreSQL version.
- Removing a CLI command or changing the generated project in a way that breaks `npm start` or
  `npm run migrate` in an existing project.

## Deprecation policy

1. A deprecation ships in a minor release. It is announced under "Deprecated" in `CHANGELOG.md`,
   marked `@deprecated` in the TypeScript declaration with the replacement, and documented.
2. A deprecated API keeps working, unchanged, for at least one further minor release and at least
   three months, and is removed only in a major release.
3. HTTP deprecations are announced in `CHANGELOG.md` and `docs/API.md`. Maa does not send
   `Deprecation` or `Sunset` headers yet.
4. Removal lists the replacement and the upgrade steps under "Breaking changes".

Legacy APIs kept for compatibility, supported throughout 1.x (none is formally deprecated yet):

| Legacy | Preferred |
|---|---|
| `validateBody()` | `withInput()` |
| `requireApiKey()`, `optionalApiKey()`, `requireRole()` | `createAuthenticator()`, `requirePermission()` |
| `ExtensionRegistry.emit()` (inline, no delivery guarantee) | `context.events.publish()` inside the transaction |
| `ModuleContext.loginLimiter`, `ModuleContext.registrationLimiter` | `ModuleContext.limiters` |

## HTTP API versions

The HTTP contract follows the package major. `API_BASE_PATH` (for example `/v1`) lets a store put the
API under a version prefix now, so that a future major can be introduced under `/v2` at the proxy.
System routes stay at the root.

## Pull request checklist

- Does the diff of `docs/openapi.json` remove, rename or tighten anything? Then it is breaking.
- Does it change `src/index.ts`, `ModuleContext`, a provider interface or `CommerceEvents`?
  Classify it with the rules above.
- Add an entry to the "Unreleased" section of `CHANGELOG.md` under the right heading.
- Bump the version at release time in `package.json` and in the OpenAPI `info.version` set in
  `src/app.ts` (it is a literal there, not read from `package.json`).

## Supported versions

The latest minor of the current major receives fixes. Security fixes go to the latest minor; older
minors of the same major are expected to upgrade, which is safe by the rules above. 0.1.0 is not
supported.
