# 0009. Own HTTP layer and router instead of Express or Fastify

- Status: Accepted
- Since: 0.1.0 (hardened in 1.0.0)

## Context

The project's dependency rule is "few dependencies, each justified"; the runtime dependencies are
`pg`, `dotenv` and `commander`. The request lifecycle also needs precise control that frameworks make
awkward or hide:

- global middleware (CORS, security headers, logging, metrics, audit) must run before routing, so an
  `OPTIONS` preflight to a path with no route still gets CORS headers (bug 1 in the project report);
- the body is read as a pipeline step after global middleware, with a size limit enforced while
  streaming, and the raw bytes kept for webhook signatures;
- a request id on every response, log line and error body;
- one place where any thrown error becomes the HTTP error contract;
- system routes (`/health`, `/livez`, `/readyz`, `/metrics`, `/openapi.json`) at the root while the
  API may live under a version prefix;
- route metadata (input schemas, auth, permission) that the OpenAPI generator can read.

## Decision

- `createServer()` (`src/engine/http/server.ts`) wraps `node:http`. Per request: assign `req.id`
  (valid incoming `X-Request-Id` or a new UUID) and a child logger, match system routes then API
  routes (after stripping `basePath`), build the chain
  `global middleware -> readBody -> route middleware -> handler`, and send every error through one
  `onError` that calls `toErrorResponse()`.
- Body reading rejects a declared `Content-Length` above the limit before reading, counts bytes while
  streaming, answers 413 with `Connection: close`, keeps `req.rawBody`, and maps malformed JSON to
  400 `MALFORMED_JSON`.
- `Router` (`src/engine/router.ts`) compiles each path to a regular expression once; first match in
  registration order wins; a duplicate method and path fails at startup; `HEAD` is served by the
  `GET` route; a known path with another method is 405 with `Allow`; a malformed percent-escape is
  400 `MALFORMED_URL`.
- Handlers share one signature `(req, res, next)`, run by `runPipeline()`.
- Server timeouts are set in `createCommerceApp()`: request 30 s, headers 15 s, keep-alive 5 s.

## Consequences

- The whole HTTP path is about 700 lines, most of them comments, that the team understands line by
  line, with no framework advisories to track.
- Ordering problems (CORS before 404, body limit before parse, raw body) are solved structurally.
- Route metadata doubles as the OpenAPI source.
- We own HTTP edge cases. Covered by tests: chunked bodies over the limit, HEAD, 405, malformed URLs,
  router fuzzing (`tests/integration/hardening.test.ts`, `tests/unit/router-v2.test.ts`).
- No ecosystem middleware: no compression (do it at the proxy), no multipart uploads, no content
  negotiation. Request and response bodies are JSON; other content types arrive as text.
- Route matching is linear in the number of routes (about 73 operations); negligible here.

## Alternatives considered

- **Express.** Large ecosystem, but legacy async error handling, and the CORS-before-404 and
  body-limit ordering would still need custom code.
- **Fastify.** The strongest alternative: fast, schema-driven validation and OpenAPI built in.
  Rejected for the dependency rule and the project's learning goal. It would be the choice if the
  rule were dropped.
- **Koa, Hono.** Smaller, but the same trade: a dependency for features we needed to control anyway.
