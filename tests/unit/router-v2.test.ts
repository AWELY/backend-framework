import { test } from "node:test";
import assert from "node:assert/strict";
import { Router, ValidationError, withMeta, type Handler } from "../../src/index";

const ok: Handler = (_req, res) => res.json({});

test("HEAD is served by the GET route, and allowedMethods lists HEAD with GET", () => {
  const router = new Router();
  router.get("/health", ok);
  router.post("/orders", ok);
  assert.equal(router.match("HEAD", "/health")?.route.path, "/health");
  assert.deepEqual(router.allowedMethods("/health").sort(), ["GET", "HEAD"]);
  assert.deepEqual(router.allowedMethods("/orders"), ["POST"]);
  assert.deepEqual(router.allowedMethods("/nothing"), []);
});

test("malformed percent-encoding in a parameter is a 400 MALFORMED_URL, not a crash", () => {
  const router = new Router();
  router.get("/products/:id", ok);
  try {
    router.match("GET", "/products/%E0%A4%A");
    assert.fail("expected an error");
  } catch (err) {
    assert.ok(err instanceof ValidationError);
    assert.equal(err.code, "MALFORMED_URL");
    assert.equal(err.statusCode, 400);
  }
});

test("registering the same method and path twice fails at startup", () => {
  const router = new Router();
  router.get("/x", ok);
  assert.throws(() => router.get("/x", ok), /already registered/);
  router.post("/x", ok); // طريقة أخرى: مسموح
});

test("route metadata from every handler is merged and listed", () => {
  const router = new Router();
  const auth = withMeta(((_req, _res, next) => next()) as Handler, { auth: "required" });
  const perm = withMeta(((_req, _res, next) => next()) as Handler, { permission: "products:write" });
  router.post("/products", auth, perm, withMeta(ok, { summary: "Create", successStatus: 201 }));
  const [info] = router.list();
  assert.deepEqual(info?.meta, { auth: "required", permission: "products:write", summary: "Create", successStatus: 201 });
});

test("fuzz: random paths either match, miss, or raise ValidationError", () => {
  const router = new Router();
  router.get("/products/:id", ok);
  router.get("/carts/:id/items/:productId", ok);
  const alphabet = ["/", "a", "%", "E0", "A4", "%2F", "..", ":", "?", "é", "%%", "%zz", "products", "carts", "items"];
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < 5000; i++) {
    const path = "/" + Array.from({ length: 1 + Math.floor(random() * 6) }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
    try {
      router.match("GET", path);
      router.allowedMethods(path);
    } catch (err) {
      assert.ok(err instanceof ValidationError, `${path} threw ${String(err)}`);
    }
  }
});
