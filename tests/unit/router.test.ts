import { test } from "node:test";
import assert from "node:assert/strict";
import { Router } from "../../src/index";

const noop = () => undefined;

test("matches static and :param routes and decodes params", () => {
  const r = new Router();
  r.get("/products", noop);
  r.get("/products/:id", noop);
  assert.ok(r.match("GET", "/products"));
  assert.deepEqual(r.match("GET", "/products/a%20b")?.params, { id: "a b" });
});

test("does not match extra segments or other methods", () => {
  const r = new Router();
  r.get("/products/:id", noop);
  assert.equal(r.match("GET", "/products/1/extra"), null);
  assert.equal(r.match("POST", "/products/1"), null);
});

test("route-level middleware is kept separate from the final handler", () => {
  const r = new Router();
  const mw = () => undefined;
  const handler = () => undefined;
  r.post("/x", mw, handler);
  const match = r.match("POST", "/x");
  assert.deepEqual(match?.route.middleware, [mw]);
  assert.equal(match?.route.handler, handler);
});
