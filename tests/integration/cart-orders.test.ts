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

const contact = { contactName: "Ali", contactPhone: "+218 92 111 2233", shippingAddress: "Tripoli, Souq Al-Juma" };

async function product(slug: string, price: number, stock: number): Promise<string> {
  const p = await api(t.base, "POST", "/products", { owner: true, body: { name: slug, slug, price } });
  await api(t.base, "PUT", `/inventory/${p.body.id}`, { owner: true, body: { quantity: stock } });
  return p.body.id as string;
}

async function customerToken(email: string): Promise<string> {
  const res = await api(t.base, "POST", "/customers/register", { body: { email, password: "password-123", name: "C" } });
  return res.body.token as string;
}

const stockOf = async (id: string) => (await api(t.base, "GET", `/inventory/${id}`)).body.quantity as number;

test("guest: cart -> checkout -> order; stock goes down, cart is closed", async () => {
  const mug = await product("mug", 15000, 5);
  const plate = await product("plate", 8000, 2);

  const cart = await api(t.base, "POST", "/carts");
  assert.equal(cart.status, 201);
  assert.equal(cart.body.customerId, null);
  const cartId = cart.body.id as string;

  await api(t.base, "POST", `/carts/${cartId}/items`, { body: { productId: mug, quantity: 2 } });
  const withItems = await api(t.base, "POST", `/carts/${cartId}/items`, { body: { productId: plate, quantity: 1 } });
  assert.equal(withItems.body.total, 2 * 15000 + 8000);

  const order = await api(t.base, "POST", "/orders", { body: { cartId, ...contact } });
  assert.equal(order.status, 201);
  assert.equal(order.body.status, "pending");
  assert.equal(order.body.total, 38000);
  assert.equal(order.body.items.length, 2);

  assert.equal(await stockOf(mug), 3);
  assert.equal(await stockOf(plate), 1);

  // The cart cannot be reused or checked out again.
  assert.equal((await api(t.base, "POST", `/carts/${cartId}/items`, { body: { productId: mug, quantity: 1 } })).status, 409);
  assert.equal((await api(t.base, "POST", "/orders", { body: { cartId, ...contact } })).status, 409);
});

test("adding more than is in stock is refused; empty cart cannot be checked out", async () => {
  const lamp = await product("lamp", 1000, 1);
  const cartId = (await api(t.base, "POST", "/carts")).body.id as string;
  const tooMany = await api(t.base, "POST", `/carts/${cartId}/items`, { body: { productId: lamp, quantity: 2 } });
  assert.equal(tooMany.status, 409);
  assert.equal((await api(t.base, "POST", "/orders", { body: { cartId, ...contact } })).status, 400);
});

test("checkout is all-or-nothing: if one line is short, nothing is sold", async () => {
  const a = await product("item-a", 100, 5);
  const b = await product("item-b", 100, 1);
  const cartId = (await api(t.base, "POST", "/carts")).body.id as string;
  await api(t.base, "POST", `/carts/${cartId}/items`, { body: { productId: a, quantity: 3 } });
  await api(t.base, "POST", `/carts/${cartId}/items`, { body: { productId: b, quantity: 1 } });
  // Someone else buys the last B before this checkout.
  await api(t.base, "POST", `/inventory/${b}/adjust`, { owner: true, body: { delta: -1 } });

  const res = await api(t.base, "POST", "/orders", { body: { cartId, ...contact } });
  assert.equal(res.status, 409);
  assert.equal(await stockOf(a), 5, "A must be untouched because the transaction rolled back");
  assert.equal((await api(t.base, "GET", `/carts/${cartId}`)).body.status, "open");
});

test("double-click: two simultaneous checkouts of one cart create exactly one order", async () => {
  const p = await product("single", 500, 10);
  const cartId = (await api(t.base, "POST", "/carts")).body.id as string;
  await api(t.base, "POST", `/carts/${cartId}/items`, { body: { productId: p, quantity: 2 } });

  const [r1, r2] = await Promise.all([
    api(t.base, "POST", "/orders", { body: { cartId, ...contact } }),
    api(t.base, "POST", "/orders", { body: { cartId, ...contact } }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [201, 409]);
  assert.equal(await stockOf(p), 8, "stock decremented once, not twice");
});

test("order keeps the price paid even if the product is repriced later", async () => {
  const p = await product("repriced", 1000, 5);
  const cartId = (await api(t.base, "POST", "/carts")).body.id as string;
  await api(t.base, "POST", `/carts/${cartId}/items`, { body: { productId: p, quantity: 1 } });
  const order = await api(t.base, "POST", "/orders", { body: { cartId, ...contact } });
  await api(t.base, "PATCH", `/products/${p}`, { owner: true, body: { price: 9999 } });
  const again = await api(t.base, "GET", `/orders/${order.body.id}`, { owner: true });
  assert.equal(again.body.items[0].unitPrice, 1000);
  assert.equal(again.body.total, 1000);
});

test("guest order lookup needs the matching phone; others get 404", async () => {
  const p = await product("tracked", 100, 5);
  const cartId = (await api(t.base, "POST", "/carts")).body.id as string;
  await api(t.base, "POST", `/carts/${cartId}/items`, { body: { productId: p, quantity: 1 } });
  const id = (await api(t.base, "POST", "/orders", { body: { cartId, ...contact } })).body.id as string;

  assert.equal((await api(t.base, "GET", `/orders/${id}`)).status, 404);
  assert.equal((await api(t.base, "GET", `/orders/${id}?phone=0000000`)).status, 404);
  assert.equal((await api(t.base, "GET", `/orders/${id}?phone=${encodeURIComponent("+218921112233")}`)).status, 200);
});

test("customer: cart is private, orders are linked to the account and listed", async () => {
  const p = await product("for-customer", 2000, 5);
  const ali = await customerToken("ali@example.com");
  const mona = await customerToken("mona@example.com");

  const cart = await api(t.base, "POST", "/carts", { token: ali });
  assert.ok(cart.body.customerId);
  const cartId = cart.body.id as string;

  // Another customer, or an anonymous guest, cannot even see it.
  assert.equal((await api(t.base, "GET", `/carts/${cartId}`, { token: mona })).status, 404);
  assert.equal((await api(t.base, "GET", `/carts/${cartId}`)).status, 404);

  await api(t.base, "POST", `/carts/${cartId}/items`, { token: ali, body: { productId: p, quantity: 1 } });
  const order = await api(t.base, "POST", "/orders", { token: ali, body: { cartId, ...contact } });
  assert.equal(order.status, 201);
  assert.equal(order.body.customerId, cart.body.customerId);

  const aliOrders = await api(t.base, "GET", "/orders", { token: ali });
  assert.deepEqual(aliOrders.body.map((o: { id: string }) => o.id), [order.body.id]);
  assert.deepEqual((await api(t.base, "GET", "/orders", { token: mona })).body, []);
  assert.equal((await api(t.base, "GET", `/orders/${order.body.id}`, { token: mona })).status, 404);
  assert.equal((await api(t.base, "GET", `/orders/${order.body.id}`, { token: ali })).status, 200);
});

test("status: only allowed transitions; only the owner; cancelling restocks", async () => {
  const p = await product("status-flow", 100, 4);
  const token = await customerToken("status@example.com");
  const cartId = (await api(t.base, "POST", "/carts")).body.id as string;
  await api(t.base, "POST", `/carts/${cartId}/items`, { body: { productId: p, quantity: 3 } });
  const id = (await api(t.base, "POST", "/orders", { body: { cartId, ...contact } })).body.id as string;
  assert.equal(await stockOf(p), 1);

  assert.equal((await api(t.base, "PATCH", `/orders/${id}/status`, { token, body: { status: "confirmed" } })).status, 403);
  assert.equal((await api(t.base, "PATCH", `/orders/${id}/status`, { owner: true, body: { status: "delivered" } })).status, 409);
  assert.equal((await api(t.base, "PATCH", `/orders/${id}/status`, { owner: true, body: { status: "confirmed" } })).body.status, "confirmed");

  const cancelled = await api(t.base, "PATCH", `/orders/${id}/status`, { owner: true, body: { status: "cancelled" } });
  assert.equal(cancelled.body.status, "cancelled");
  assert.equal(await stockOf(p), 4, "cancelled items are back in stock");
  assert.equal((await api(t.base, "PATCH", `/orders/${id}/status`, { owner: true, body: { status: "pending" } })).status, 409);
});
