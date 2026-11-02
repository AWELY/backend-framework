import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  startTestApp,
  api,
  createProduct,
  createCart,
  registerCustomer,
  createStaff,
  CONTACT,
  type TestApp,
} from "../helpers/test-app";
import { cashOnDelivery, coupons, percentageTax, flatRateShipping, ORDERS_SERVICE } from "../../src/index";
import { hostedGateway } from "../../examples/plugins/hosted-gateway";

let refundShouldFail = false;
let t: TestApp;
before(async () => {
  t = await startTestApp({
    plugins: [
      flatRateShipping({ rate: 2000 }),
      cashOnDelivery(),
      hostedGateway({
        checkoutUrl: "https://pay.example/checkout",
        webhookSecret: "whsec_test",
        holdSeconds: 600,
        refund: async (orderId, amount) => {
          if (refundShouldFail) throw new Error("gateway refused");
          return `GW-RF-${orderId.slice(0, 4)}-${amount}`;
        },
      }),
      coupons(),
      percentageTax({ ratePercent: 10, label: "VAT" }),
    ],
  });
});
after(async () => {
  await t.close();
});

const checkout = (cartId: string, extra: Record<string, unknown> = {}, token?: string) =>
  api(t.base, "POST", "/orders", { token, body: { cartId, ...CONTACT, shippingMethod: "flat-rate", paymentMethod: "cod", ...extra } });

test("variants: own SKU, price override and stock; a product with variants needs one", async () => {
  const product = await api(t.base, "POST", "/products", { owner: true, body: { name: "Phone case", slug: "case-variants", price: 5000 } });
  const black = await api(t.base, "POST", `/products/${product.body.id}/variants`, { owner: true, body: { sku: "CASE-BLK", title: "Black" } });
  const gold = await api(t.base, "POST", `/products/${product.body.id}/variants`, { owner: true, body: { sku: "CASE-GLD", title: "Gold", price: 7000, position: 1 } });
  assert.equal(black.status, 201);
  await api(t.base, "PUT", `/inventory/variants/${black.body.id}`, { owner: true, body: { quantity: 5 } });
  await api(t.base, "PUT", `/inventory/variants/${gold.body.id}`, { owner: true, body: { quantity: 1 } });

  const detail = await api(t.base, "GET", `/products/${product.body.id}`);
  assert.deepEqual(detail.body.variants.map((v: { sku: string }) => v.sku), ["CASE-BLK", "CASE-GLD"]);
  const stock = await api(t.base, "GET", `/inventory/${product.body.id}`);
  assert.deepEqual(stock.body.variants.map((v: { quantity: number }) => v.quantity), [5, 1]);

  const cart = await api(t.base, "POST", "/carts");
  const noVariant = await api(t.base, "POST", `/carts/${cart.body.id}/items`, { body: { productId: product.body.id, quantity: 1 } });
  assert.equal(noVariant.status, 400);
  assert.equal(noVariant.body.error.code, "VARIANT_REQUIRED");
  const tooMany = await api(t.base, "POST", `/carts/${cart.body.id}/items`, { body: { productId: product.body.id, variantId: gold.body.id, quantity: 2 } });
  assert.equal(tooMany.body.error.code, "INSUFFICIENT_STOCK");
  await api(t.base, "POST", `/carts/${cart.body.id}/items`, { body: { productId: product.body.id, variantId: gold.body.id, quantity: 1 } });
  const withBlack = await api(t.base, "POST", `/carts/${cart.body.id}/items`, { body: { productId: product.body.id, variantId: black.body.id, quantity: 2 } });
  assert.deepEqual(
    withBlack.body.items.map((i: { sku: string; unitPrice: number; quantity: number }) => [i.sku, i.unitPrice, i.quantity]),
    [["CASE-GLD", 7000, 1], ["CASE-BLK", 5000, 2]]
  );
  // تعديل كمية شكل محدد عبر ?variantId=
  const updated = await api(t.base, "PUT", `/carts/${cart.body.id}/items/${product.body.id}?variantId=${black.body.id}`, { body: { quantity: 3 } });
  assert.equal(updated.body.items.find((i: { sku: string }) => i.sku === "CASE-BLK").quantity, 3);

  const order = await checkout(cart.body.id);
  assert.equal(order.status, 201, JSON.stringify(order.body));
  assert.deepEqual(order.body.items.map((i: { sku: string; variantTitle: string }) => [i.sku, i.variantTitle]), [["CASE-GLD", "Gold"], ["CASE-BLK", "Black"]]);
  const after = await api(t.base, "GET", `/inventory/${product.body.id}`);
  assert.deepEqual(after.body.variants.map((v: { quantity: number }) => v.quantity), [2, 0]);
});

test("guest cart merges into the customer's cart at registration and at login", async () => {
  const p1 = await createProduct(t.base);
  const p2 = await createProduct(t.base);
  const guest = await createCart(t.base, [{ productId: p1, quantity: 2 }]);
  const customer = await registerCustomer(t.base, { guestCartId: guest });
  assert.equal(customer.cartId, guest, "with no cart of their own, the guest cart becomes theirs");
  assert.equal((await api(t.base, "GET", "/carts/mine", { token: customer.token })).body.id, guest);

  const secondGuest = await createCart(t.base, [{ productId: p1, quantity: 1 }, { productId: p2, quantity: 4 }]);
  const login = await api(t.base, "POST", "/customers/login", { body: { email: customer.email, password: customer.password, guestCartId: secondGuest } });
  assert.equal(login.body.cartId, guest);
  const merged = await api(t.base, "GET", `/carts/${guest}`, { token: login.body.token });
  assert.deepEqual(
    merged.body.items.map((i: { productId: string; quantity: number }) => [i.productId, i.quantity]).sort(),
    [[p1, 3], [p2, 4]].sort()
  );
  assert.equal((await api(t.base, "GET", `/carts/${secondGuest}`)).status, 404, "the merged guest cart is gone");
});

test("coupons and tax: priced in the quote, stored on the order, redemptions counted and released on cancel", async () => {
  const coupon = await api(t.base, "POST", "/coupons", { owner: true, body: { code: "save20", kind: "percent", value: 20, maxRedemptions: 5 } });
  assert.equal(coupon.status, 201);
  assert.equal(coupon.body.code, "SAVE20");
  const productId = await createProduct(t.base, { price: 10_000 });
  const cartId = await createCart(t.base, [{ productId, quantity: 2 }]);

  const quote = await api(t.base, "POST", "/checkout/quote", { body: { cartId, shippingAddress: "Tripoli center", shippingMethod: "flat-rate", couponCode: "save20" } });
  // 20000 - خصم 4000 = 16000، ضريبة 10% = 1600، شحن 2000 => 19600
  assert.deepEqual(
    quote.body.adjustments.map((a: { code: string; type: string; amount: number }) => [a.code, a.type, a.amount]),
    [["COUPON:SAVE20", "discount", 4000], ["TAX", "tax", 1600]]
  );
  assert.equal(quote.body.adjustmentsTotal, -2400);
  assert.equal(quote.body.total, 19_600);

  const bad = await api(t.base, "POST", "/checkout/quote", { body: { cartId, shippingAddress: "Tripoli center", shippingMethod: "flat-rate", couponCode: "NOPE" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "INVALID_COUPON");

  const order = await checkout(cartId, { couponCode: "SAVE20" });
  assert.equal(order.body.total, 19_600);
  assert.equal(order.body.subtotal + order.body.shippingCost + order.body.adjustmentsTotal, order.body.total);
  await t.app.drainBackgroundWork();
  assert.equal((await api(t.base, "GET", "/coupons", { owner: true })).body.find((c: { code: string }) => c.code === "SAVE20").redeemedCount, 1);

  await api(t.base, "PATCH", `/orders/${order.body.id}/status`, { owner: true, body: { status: "cancelled" } });
  await t.app.drainBackgroundWork();
  assert.equal((await api(t.base, "GET", "/coupons", { owner: true })).body.find((c: { code: string }) => c.code === "SAVE20").redeemedCount, 0);
  assert.equal((await api(t.base, "GET", "/checkout/options")).body.couponsEnabled, true);
});

test("money is BIGINT: prices above 2^31 round-trip as numbers", async () => {
  const product = await api(t.base, "POST", "/products", { owner: true, body: { name: "Gold bar", slug: "gold-bar", price: 3_000_000_000 } });
  assert.equal(product.body.price, 3_000_000_000);
  assert.equal((await api(t.base, "GET", `/products/${product.body.id}`)).body.price, 3_000_000_000);
});

test("payment holds: an unpaid online order is cancelled after its hold and its stock comes back", async () => {
  const productId = await createProduct(t.base, { stock: 3 });
  const cartId = await createCart(t.base, [{ productId, quantity: 2 }]);
  const order = await checkout(cartId, { paymentMethod: "hosted" });
  assert.equal(order.body.paymentStatus, "pending");
  assert.ok(order.body.paymentExpiresAt, "the hold has an expiry");
  assert.equal((await api(t.base, "GET", `/inventory/${productId}`)).body.quantity, 1);

  // COD لا مهلة له.
  const codCart = await createCart(t.base, [{ productId, quantity: 1 }]);
  assert.equal((await checkout(codCart)).body.paymentExpiresAt, null);

  await t.app.pool.query("UPDATE orders SET payment_expires_at = now() - interval '1 second' WHERE id = $1", [order.body.id]);
  const released = await t.app.container.resolve(ORDERS_SERVICE).releaseExpiredHolds();
  assert.equal(released, 1);
  const cancelled = await api(t.base, "GET", `/orders/${order.body.id}`, { owner: true });
  assert.equal(cancelled.body.status, "cancelled");
  assert.equal(cancelled.body.paymentExpiresAt, null);
  assert.equal((await api(t.base, "GET", `/inventory/${productId}`)).body.quantity, 2);
  const timeline = await api(t.base, "GET", `/orders/${order.body.id}/events`, { owner: true });
  assert.ok(timeline.body.some((e: { type: string; to: string; note: string }) => e.type === "status" && e.to === "cancelled" && e.note === "payment_expired"));
});

test("refunds: partial with restock, never more than paid, gateway failure changes nothing", async () => {
  const productId = await createProduct(t.base, { price: 10_000, stock: 10 });
  const cartId = await createCart(t.base, [{ productId, quantity: 3 }]);
  const order = (await checkout(cartId)).body;
  const unpaid = await api(t.base, "POST", `/orders/${order.id}/refunds`, { owner: true, body: { amount: 100 } });
  assert.equal(unpaid.body.error.code, "ORDER_NOT_REFUNDABLE");
  await api(t.base, "PATCH", `/orders/${order.id}/payment`, { owner: true, body: { status: "paid" } });

  const partial = await api(t.base, "POST", `/orders/${order.id}/refunds`, {
    owner: true,
    body: { amount: 10_000, reason: "One item returned", restock: [{ productId, quantity: 1 }] },
  });
  assert.equal(partial.status, 201, JSON.stringify(partial.body));
  assert.equal(partial.body.order.paymentStatus, "partially_refunded");
  assert.equal(partial.body.order.refundedTotal, 10_000);
  assert.equal(partial.body.order.items[0].restockedQuantity, 1);
  assert.equal(partial.body.refund.status, "succeeded");
  assert.equal((await api(t.base, "GET", `/inventory/${productId}`)).body.quantity, 8);

  const tooMuch = await api(t.base, "POST", `/orders/${order.id}/refunds`, { owner: true, body: { amount: order.total } });
  assert.equal(tooMuch.body.error.code, "REFUND_EXCEEDS_PAID");
  const overRestock = await api(t.base, "POST", `/orders/${order.id}/refunds`, { owner: true, body: { amount: 1, restock: [{ productId, quantity: 3 }] } });
  assert.equal(overRestock.status, 400);

  const rest = await api(t.base, "POST", `/orders/${order.id}/refunds`, { owner: true, body: { amount: order.total - 10_000 } });
  assert.equal(rest.body.order.paymentStatus, "refunded");
  assert.equal((await api(t.base, "GET", `/orders/${order.id}/refunds`, { owner: true })).body.length, 2);

  // بوابة ترفض الاسترجاع: 502، ولا يتغير المبلغ المسترجع.
  const gwCart = await createCart(t.base, [{ productId, quantity: 1 }]);
  const gwOrder = (await checkout(gwCart, { paymentMethod: "hosted" })).body;
  await t.app.container.resolve(ORDERS_SERVICE).setPaymentStatus(gwOrder.id, "paid");
  refundShouldFail = true;
  const failed = await api(t.base, "POST", `/orders/${gwOrder.id}/refunds`, { owner: true, body: { amount: 1000 } });
  refundShouldFail = false;
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error.code, "PAYMENT_PROVIDER_ERROR");
  assert.equal((await api(t.base, "GET", `/orders/${gwOrder.id}`, { owner: true })).body.refundedTotal, 0);
  const viaGateway = await api(t.base, "POST", `/orders/${gwOrder.id}/refunds`, { owner: true, body: { amount: 1000 } });
  assert.match(viaGateway.body.refund.reference, /^GW-RF-/);
});

test("delivery: assign, pickup, deliver with cash collection; couriers only touch their own; full timeline", async () => {
  const admin = await createStaff(t.base, "admin");
  const courier = await createStaff(t.base, "courier", { name: "Salem the courier" });
  const otherCourier = await createStaff(t.base, "courier");
  const support = await createStaff(t.base, "support");
  const productId = await createProduct(t.base, { price: 15_000 });
  const cartId = await createCart(t.base, [{ productId, quantity: 1 }]);
  const order = (await checkout(cartId)).body;

  assert.equal((await api(t.base, "POST", `/orders/${order.id}/delivery`, { token: support.token, body: { courierId: courier.staff.id } })).status, 403);
  assert.equal(
    (await api(t.base, "POST", `/orders/${order.id}/delivery`, { token: admin.token, body: { courierId: support.staff.id } })).status,
    400,
    "only couriers can be assigned"
  );
  const assigned = await api(t.base, "POST", `/orders/${order.id}/delivery`, { token: admin.token, body: { courierId: courier.staff.id, note: "Fragile" } });
  assert.equal(assigned.status, 201);
  assert.equal(assigned.body.status, "assigned");
  assert.equal(assigned.body.courierName, "Salem the courier");
  assert.equal((await api(t.base, "GET", `/orders/${order.id}`, { owner: true })).body.status, "confirmed", "assignment confirms a pending order");

  const mine = await api(t.base, "GET", "/deliveries", { token: courier.token });
  assert.equal(mine.headers.get("x-total-count"), "1");
  assert.equal(mine.body[0].order.contactPhone, CONTACT.contactPhone);
  assert.equal(mine.body[0].order.total, order.total);
  assert.equal((await api(t.base, "GET", "/deliveries", { token: otherCourier.token })).body.length, 0);
  assert.equal((await api(t.base, "POST", `/deliveries/${order.id}/pickup`, { token: otherCourier.token })).status, 404);

  const picked = await api(t.base, "POST", `/deliveries/${order.id}/pickup`, { token: courier.token });
  assert.equal(picked.body.status, "picked_up");
  assert.equal((await api(t.base, "GET", `/orders/${order.id}`, { owner: true })).body.status, "shipped");

  const wrongCash = await api(t.base, "POST", `/deliveries/${order.id}/deliver`, { token: courier.token, body: { cashCollected: 100 } });
  assert.equal(wrongCash.status, 400);
  const delivered = await api(t.base, "POST", `/deliveries/${order.id}/deliver`, { token: courier.token, body: { cashCollected: order.total, note: "Left with the guard" } });
  assert.equal(delivered.body.status, "delivered");
  const final = await api(t.base, "GET", `/orders/${order.id}`, { owner: true });
  assert.equal(final.body.status, "delivered");
  assert.equal(final.body.paymentStatus, "paid");

  // الضيف يتتبع طلبه بهاتفه: يرى التوصيل والسجل الزمني.
  const tracked = await api(t.base, "GET", `/orders/${order.id}/delivery?phone=${CONTACT.contactPhone}`);
  assert.equal(tracked.body.courierName, "Salem the courier");
  const timeline = await api(t.base, "GET", `/orders/${order.id}/events?phone=${CONTACT.contactPhone}`);
  assert.deepEqual(
    timeline.body.map((e: { type: string; to: string }) => `${e.type}:${e.to}`),
    ["created:pending", "payment:pending", "status:confirmed", "delivery:assigned", "status:shipped", "delivery:picked_up", "status:delivered", "payment:paid", "delivery:delivered"]
  );
  assert.equal((await api(t.base, "GET", `/orders/${order.id}/events?phone=0000000`)).status, 404);
});

test("delivery: a failed attempt keeps the order, which can be reassigned and delivered", async () => {
  const admin = await createStaff(t.base, "manager");
  const c1 = await createStaff(t.base, "courier");
  const c2 = await createStaff(t.base, "courier");
  const productId = await createProduct(t.base);
  const cartId = await createCart(t.base, [{ productId, quantity: 1 }]);
  const order = (await checkout(cartId)).body;
  await api(t.base, "POST", `/orders/${order.id}/delivery`, { token: admin.token, body: { courierId: c1.staff.id } });
  await api(t.base, "POST", `/deliveries/${order.id}/pickup`, { token: c1.token });
  assert.equal((await api(t.base, "POST", `/deliveries/${order.id}/fail`, { token: c1.token, body: {} })).status, 400, "a reason is required");
  const failed = await api(t.base, "POST", `/deliveries/${order.id}/fail`, { token: c1.token, body: { note: "Customer not answering" } });
  assert.equal(failed.body.status, "failed");
  assert.equal(failed.body.attempts, 1);
  const reassigned = await api(t.base, "POST", `/orders/${order.id}/delivery`, { token: admin.token, body: { courierId: c2.staff.id } });
  assert.equal(reassigned.body.courierId, c2.staff.id);
  await api(t.base, "POST", `/deliveries/${order.id}/pickup`, { token: c2.token });
  const done = await api(t.base, "POST", `/deliveries/${order.id}/deliver`, { token: c2.token, body: { cashCollected: order.total } });
  assert.equal(done.body.status, "delivered");
  assert.equal((await api(t.base, "GET", "/deliveries?status=delivered", { token: admin.token })).status, 200);
});

test("coupons: duplicate code is 409, invalid percent or date is 400, never a 500", async () => {
  const body = { code: "ONCE5", kind: "percent", value: 5 };
  assert.equal((await api(t.base, "POST", "/coupons", { owner: true, body })).status, 201);
  const dup = await api(t.base, "POST", "/coupons", { owner: true, body: { ...body, code: "once5" } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, "DUPLICATE_VALUE");
  const tooMuch = await api(t.base, "PATCH", "/coupons/ONCE5", { owner: true, body: { value: 150 } });
  assert.equal(tooMuch.status, 400);
  assert.equal(tooMuch.body.error.details[0].field, "value");
  const badDate = await api(t.base, "POST", "/coupons", { owner: true, body: { code: "BADDATE", kind: "fixed", value: 1000, expiresAt: "2026-13-45T00:00:00Z" } });
  assert.equal(badDate.status, 400);
  assert.equal((await api(t.base, "PATCH", "/coupons/NOPE", { owner: true, body: { isActive: false } })).status, 404);
});
