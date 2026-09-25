import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, api, type TestApp } from "../helpers/test-app";

let t: TestApp;
before(async () => {
  t = await startTestApp();
});
after(async () => {
  await t.close();
});

async function newProduct(slug: string): Promise<string> {
  const res = await api(t.base, "POST", "/products", { owner: true, body: { name: slug, slug, price: 1000 } });
  assert.equal(res.status, 201);
  return res.body.id as string;
}

test("unknown products are 404; a never-stocked product has 0", async () => {
  assert.equal((await api(t.base, "GET", "/inventory/00000000-0000-0000-0000-000000000000")).status, 404);
  const id = await newProduct("fresh");
  const res = await api(t.base, "GET", `/inventory/${id}`);
  assert.deepEqual(res.body, { productId: id, quantity: 0, inStock: false });
});

test("set and adjust stock; going below zero is refused with 409", async () => {
  const id = await newProduct("lamp");
  assert.equal((await api(t.base, "PUT", `/inventory/${id}`, { owner: true, body: { quantity: 5 } })).body.quantity, 5);
  assert.equal((await api(t.base, "POST", `/inventory/${id}/adjust`, { owner: true, body: { delta: -3 } })).body.quantity, 2);
  const over = await api(t.base, "POST", `/inventory/${id}/adjust`, { owner: true, body: { delta: -3 } });
  assert.equal(over.status, 409);
  assert.equal((await api(t.base, "GET", `/inventory/${id}`)).body.quantity, 2);
});

test("stock writes are owner-only; negative absolute stock is a 400", async () => {
  const id = await newProduct("chair");
  assert.equal((await api(t.base, "PUT", `/inventory/${id}`, { body: { quantity: 5 } })).status, 401);
  assert.equal((await api(t.base, "PUT", `/inventory/${id}`, { owner: true, body: { quantity: -1 } })).status, 400);
});

test("concurrency: 10 simultaneous buyers, 5 in stock -> exactly 5 succeed, stock ends at 0", async () => {
  const id = await newProduct("last-items");
  await api(t.base, "PUT", `/inventory/${id}`, { owner: true, body: { quantity: 5 } });

  const results = await Promise.all(
    Array.from({ length: 10 }, () => api(t.base, "POST", `/inventory/${id}/adjust`, { owner: true, body: { delta: -1 } }))
  );
  const ok = results.filter((r) => r.status === 200).length;
  const refused = results.filter((r) => r.status === 409).length;

  assert.equal(ok, 5);
  assert.equal(refused, 5);
  assert.equal((await api(t.base, "GET", `/inventory/${id}`)).body.quantity, 0);
});

test("deleting a product removes its stock row too", async () => {
  const id = await newProduct("gone");
  await api(t.base, "PUT", `/inventory/${id}`, { owner: true, body: { quantity: 3 } });
  await api(t.base, "DELETE", `/products/${id}`, { owner: true });
  const { rows } = await t.app.pool.query("SELECT count(*)::int AS n FROM inventory WHERE product_id = $1", [id]);
  assert.equal(rows[0].n, 0);
});
