import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, api, type TestApp } from "../helpers/test-app";
import { cashOnDelivery, cityRateShipping } from "../../src/index";

// ميزات أُضيفت للإطار من أجل متجر ماء: صور المنتجات، والتوصيل بسعر حسب المدينة.
// المتجر هنا بثلاث مدن (بأسماء عربية) وتوصيل مجاني فوق 500 دينار، والدفع عند الاستلام.
let t: TestApp;
before(async () => {
  t = await startTestApp({
    plugins: [
      cityRateShipping({ rates: { "طرابلس": 10000, "بنغازي": 20000, "سبها": 30000 }, freeOver: 500000 }),
      cashOnDelivery(),
    ],
  });
});
after(async () => {
  await t.close();
});

/** ينشئ منتجاً (بصورة اختيارياً) بمخزون 50، ويرجع رقمه. */
async function product(slug: string, price: number, imageUrl?: string): Promise<string> {
  const res = await api(t.base, "POST", "/products", { owner: true, body: { name: slug, slug, price, imageUrl } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  await api(t.base, "PUT", `/inventory/${res.body.id}`, { owner: true, body: { quantity: 50 } });
  return res.body.id as string;
}

// رابط صورة كامل (https) أو مسار على الموقع (/images/...) مقبولان، وبلا صورة تكون null.
// المرفوض: javascript: (هجوم)، والمسار النسبي بلا "/"، و data: (صورة مضمنة).
test("product images: full URL or site path accepted, dangerous or relative-less values rejected", async () => {
  const withUrl = await api(t.base, "POST", "/products", {
    owner: true,
    body: { name: "Charger", slug: "charger", price: 25000, imageUrl: "https://cdn.example.ly/charger.jpg" },
  });
  assert.equal(withUrl.body.imageUrl, "https://cdn.example.ly/charger.jpg");

  const withPath = await api(t.base, "POST", "/products", {
    owner: true,
    body: { name: "Cable", slug: "cable", price: 8000, imageUrl: "/images/cable.jpg" },
  });
  assert.equal(withPath.body.imageUrl, "/images/cable.jpg");

  const none = await api(t.base, "POST", "/products", { owner: true, body: { name: "Case", slug: "case", price: 5000 } });
  assert.equal(none.body.imageUrl, null);

  for (const bad of ["javascript:alert(1)", "images/x.jpg", "data:image/png;base64,AAAA"]) {
    const res = await api(t.base, "POST", "/products", { owner: true, body: { name: "X", slug: `x-${bad.length}`, price: 1, imageUrl: bad } });
    assert.equal(res.status, 400, `accepted ${bad}`);
  }

  const patched = await api(t.base, "PATCH", `/products/${none.body.id}`, { owner: true, body: { imageUrl: "/images/case.jpg" } });
  assert.equal(patched.body.imageUrl, "/images/case.jpg");
});

// سطور السلة تحمل صورة المنتج، فتعرضها صفحة السلة دون طلبات إضافية.
test("cart lines carry the product image", async () => {
  const id = await product("earbuds", 60000, "/images/earbuds.jpg");
  const cartId = (await api(t.base, "POST", "/carts")).body.id as string;
  const cart = await api(t.base, "POST", `/carts/${cartId}/items`, { body: { productId: id, quantity: 1 } });
  assert.equal(cart.body.items[0].imageUrl, "/images/earbuds.jpg");
});

// خيارات الشراء تنشر مدن التوصيل بترتيبها، والأسماء العربية تصل سليمة (UTF-8).
test("checkout options publish the cities of the city-based delivery method (Arabic intact)", async () => {
  const res = await api(t.base, "GET", "/checkout/options");
  const method = res.body.shippingMethods.find((m: { id: string }) => m.id === "city-rate");
  assert.deepEqual(method.cities, ["طرابلس", "بنغازي", "سبها"]);
});

// السعر حسب المدينة، والمسافات حول الاسم تُتجاهل. والمدينة غير المخدومة أو الناقصة: 400،
// والرسالة تذكر المدن المتاحة.
test("quote prices by city; unknown or missing city is a 400 listing the served cities", async () => {
  const id = await product("smartwatch", 150000);
  const cartId = (await api(t.base, "POST", "/carts")).body.id as string;
  await api(t.base, "POST", `/carts/${cartId}/items`, { body: { productId: id, quantity: 1 } });

  const quote = (city?: string) =>
    api(t.base, "POST", "/checkout/quote", {
      body: { cartId, shippingAddress: "حي الأندلس، شارع 5", shippingMethod: "city-rate", shippingCity: city },
    });

  assert.equal((await quote("طرابلس")).body.shippingCost, 10000);
  assert.equal((await quote("سبها")).body.shippingCost, 30000);
  assert.equal((await quote(" بنغازي ")).body.shippingCost, 20000, "surrounding spaces are ignored");

  const unknown = await quote("القاهرة");
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.details[0].field, "shippingCity");
  assert.match(unknown.body.error.details[0].message, /طرابلس/);
  assert.equal((await quote(undefined)).status, 400);
});

// فوق حد 500 دينار (هنا 600000 درهم) التوصيل مجاني، في أي مدينة مخدومة.
test("free delivery over the threshold, in any served city", async () => {
  const id = await product("laptop-stand", 300000);
  const cartId = (await api(t.base, "POST", "/carts")).body.id as string;
  await api(t.base, "POST", `/carts/${cartId}/items`, { body: { productId: id, quantity: 2 } });
  const q = await api(t.base, "POST", "/checkout/quote", {
    body: { cartId, shippingAddress: "شارع جمال عبد الناصر", shippingMethod: "city-rate", shippingCity: "بنغازي" },
  });
  assert.equal(q.body.subtotal, 600000);
  assert.equal(q.body.shippingCost, 0);
});

// الطلب يحفظ المدينة وسعر توصيلها: 45000 + 30000 لسبها = 75000. والاسم العربي يُحفظ سليماً.
test("the order stores the city and the city's delivery price", async () => {
  const id = await product("power-bank", 45000);
  const cartId = (await api(t.base, "POST", "/carts")).body.id as string;
  await api(t.base, "POST", `/carts/${cartId}/items`, { body: { productId: id, quantity: 1 } });
  const order = await api(t.base, "POST", "/orders", {
    body: {
      cartId,
      contactName: "سالم",
      contactPhone: "0912223344",
      shippingAddress: "سبها، حي الجديد",
      shippingCity: "سبها",
      shippingMethod: "city-rate",
      paymentMethod: "cod",
    },
  });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  assert.equal(order.body.shippingCity, "سبها");
  assert.equal(order.body.shippingCost, 30000);
  assert.equal(order.body.total, 75000);
  assert.equal(order.body.contactName, "سالم");
});

// مدينة لا يخدمها المتجر: الشراء مرفوض (400)، ولا يُباع شيء. سعر الشحن يُحسب داخل المعاملة،
// فرفضه ألغى إنقاص المخزون: الكمية تبقى 50، والسلة مفتوحة.
test("a city the store does not serve cannot check out (and nothing is sold)", async () => {
  const id = await product("tripod", 20000);
  const cartId = (await api(t.base, "POST", "/carts")).body.id as string;
  await api(t.base, "POST", `/carts/${cartId}/items`, { body: { productId: id, quantity: 1 } });
  const res = await api(t.base, "POST", "/orders", {
    body: {
      cartId,
      contactName: "X",
      contactPhone: "0912223344",
      shippingAddress: "Somewhere 1",
      shippingCity: "غير موجودة",
      shippingMethod: "city-rate",
      paymentMethod: "cod",
    },
  });
  assert.equal(res.status, 400);
  assert.equal((await api(t.base, "GET", `/inventory/${id}`)).body.quantity, 50, "stock untouched (rolled back)");
  assert.equal((await api(t.base, "GET", `/carts/${cartId}`)).body.status, "open");
});
