import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AccessControl,
  Logger,
  MetricsRegistry,
  Router,
  generateOpenApi,
  loadConfig,
  signToken,
  signWebhookPayload,
  verifyToken,
  verifyWebhookSignature,
  withInput,
} from "../../src/index";

test("logger: JSON lines with bindings from child loggers, and sensitive fields redacted", () => {
  const lines: string[] = [];
  const logger = new Logger("debug", { format: "json", sink: (_level, line) => lines.push(line) });
  logger.child({ requestId: "r-1" }).info("hello", { password: "secret", nested: { authorization: "Bearer x" }, keep: 1 });
  const entry = JSON.parse(lines[0] as string);
  assert.equal(entry.msg, "hello");
  assert.equal(entry.level, "info");
  assert.equal(entry.requestId, "r-1");
  assert.equal(entry.password, "[REDACTED]");
  assert.equal(entry.nested.authorization, "[REDACTED]");
  assert.equal(entry.keep, 1);
});

test("logger: levels filter, errors become { name, message, stack }", () => {
  const lines: string[] = [];
  const logger = new Logger("warn", { format: "json", sink: (_l, line) => lines.push(line) });
  logger.info("dropped");
  logger.error("boom", { err: new Error("bad") });
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0] as string);
  assert.equal(entry.err.message, "bad");
  assert.match(entry.err.stack, /Error: bad/);
});

test("metrics: counters, histograms and gauges in Prometheus text format", () => {
  const registry = new MetricsRegistry();
  registry.counter("requests_total", "Requests").inc({ route: "/a", status: "200" });
  registry.counter("requests_total", "Requests").inc({ route: "/a", status: "200" }, 2);
  registry.histogram("duration_seconds", "Duration", [0.1, 1]).observe({ route: "/a" }, 0.5);
  registry.gauge("pool", "Pool", () => [{ labels: { state: "idle" }, value: 3 }]);
  const text = registry.render();
  assert.match(text, /# TYPE requests_total counter/);
  assert.match(text, /requests_total\{route="\/a",status="200"\} 3/);
  assert.match(text, /duration_seconds_bucket\{le="0.1",route="\/a"\} 0/);
  assert.match(text, /duration_seconds_bucket\{le="1",route="\/a"\} 1/);
  assert.match(text, /duration_seconds_count\{route="\/a"\} 1/);
  assert.match(text, /pool\{state="idle"\} 3/);
});

test("webhook signatures: valid, tampered, expired, rotated secrets", () => {
  const body = '{"orderId":"x","status":"paid"}';
  const now = Date.now();
  const header = signWebhookPayload(body, "s1", now);
  assert.equal(verifyWebhookSignature({ payload: body, header, secret: "s1", now }), true);
  assert.equal(verifyWebhookSignature({ payload: body.replace("paid", "failed"), header, secret: "s1", now }), false);
  assert.equal(verifyWebhookSignature({ payload: body, header, secret: "s2", now }), false);
  assert.equal(verifyWebhookSignature({ payload: body, header, secret: ["s2", "s1"], now }), true);
  assert.equal(verifyWebhookSignature({ payload: body, header, secret: "s1", now: now + 10 * 60 * 1000 }), false);
  assert.equal(verifyWebhookSignature({ payload: body, header: "garbage", secret: "s1", now }), false);
  assert.equal(verifyWebhookSignature({ payload: undefined, header, secret: "s1", now }), false);
});

test("tokens: previous secrets still verify; session claims survive the round trip", () => {
  const token = signToken({ sub: "u", role: "customer", sid: "s", pt: "customer" }, "old-secret", 60);
  assert.equal(verifyToken(token, "new-secret"), null);
  const payload = verifyToken(token, ["new-secret", "old-secret"]);
  assert.equal(payload?.sid, "s");
  assert.equal(payload?.pt, "customer");
});

test("config: every problem is reported at once, valid values are parsed", () => {
  const good = loadConfig({
    OWNER_API_KEY: "a".repeat(40),
    AUTH_TOKEN_SECRET: "b".repeat(40),
    DATABASE_URL: "postgresql://u:p@localhost/db",
    PORT: "8080",
    CORS_ORIGIN: "https://shop.ly,https://admin.shop.ly",
    API_BASE_PATH: "/v1",
    NODE_ENV: "production",
  });
  assert.equal(good.port, 8080);
  assert.equal(good.logFormat, "json");
  assert.equal(good.basePath, "/v1");
  try {
    loadConfig({ OWNER_API_KEY: "short", PORT: "abc", LOG_LEVEL: "verbose", TRUST_PROXY: "yes", CURRENCY: "dinar" });
    assert.fail("expected an error");
  } catch (err) {
    const message = (err as Error).message;
    for (const name of ["OWNER_API_KEY", "AUTH_TOKEN_SECRET", "DATABASE_URL", "PORT", "LOG_LEVEL", "TRUST_PROXY", "CURRENCY"]) {
      assert.match(message, new RegExp(name), `missing ${name} in: ${message}`);
    }
  }
});

test("access control: unknown and prototype role names have no permissions", () => {
  const ac = new AccessControl();
  assert.equal(ac.can("constructor", "products:read"), false);
  assert.equal(ac.can("__proto__", "products:read"), false);
  assert.equal(ac.can("admin", "orders:refund"), true);
  assert.equal(ac.can("manager", "orders:refund"), false);
  assert.ok(ac.staffRoles().includes("courier"));
  assert.ok(!ac.staffRoles().includes("owner"));
});

test("OpenAPI is generated from route schemas and metadata", () => {
  const api = new Router();
  api.patch(
    "/products/:id",
    withInput(
      { params: { id: { type: "string" } }, body: { price: { type: "number", integer: true, min: 0 } }, partial: true, summary: "Update", conditional: true },
      (_req, res) => res.json({})
    )
  );
  const doc = generateOpenApi(api.list(), [], { title: "t", version: "1", basePath: "/v1" }) as {
    paths: Record<string, Record<string, { parameters: Array<{ name: string; in: string }>; requestBody: unknown; summary: string }>>;
  };
  const op = doc.paths["/v1/products/{id}"]?.patch;
  assert.equal(op?.summary, "Update");
  assert.ok(op?.parameters.some((p) => p.name === "id" && p.in === "path"));
  assert.ok(op?.parameters.some((p) => p.name === "If-Match" && p.in === "header"));
  assert.deepEqual(op?.requestBody, {
    required: false,
    content: { "application/json": { schema: { type: "object", properties: { price: { type: "integer", minimum: 0 } }, additionalProperties: false } } },
  });
});

test("shutdown handlers: the first signal closes gracefully, a second one exits at once", async () => {
  const { installShutdownHandlers } = await import("../../src/index");
  const exits: number[] = [];
  let closed = 0;
  let release: () => void = () => undefined;
  const app = {
    logger: new Logger("error"),
    close: () =>
      new Promise<void>((resolve) => {
        closed++;
        release = resolve;
      }),
  };
  const uninstall = installShutdownHandlers(app, { signals: ["SIGUSR2"], exit: (code) => exits.push(code) });
  try {
    process.emit("SIGUSR2", "SIGUSR2");
    process.emit("SIGUSR2", "SIGUSR2");
    assert.deepEqual(exits, [1], "second signal exits immediately");
    release();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(closed, 1);
    assert.deepEqual(exits, [1, 0]);
  } finally {
    uninstall();
  }
});
