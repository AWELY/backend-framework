require("dotenv").config({ quiet: true });

/**
 * رحلة شراء كاملة على المتجر التجريبي وهو يعمل (شغّل npm start أولاً، في نافذة أخرى)،
 * تُطبع خطوة بخطوة. مصممة للعرض الحي أمام اللجنة.
 *
 * تستخدم الـ API العام عبر HTTP فقط، تماماً كما يفعل أي موقع أو تطبيق هاتف. لا تلمس
 * القاعدة ولا كود الإطار، وهذا يثبت أن الـ API وحده يكفي لبناء واجهة متجر (Headless).
 *
 * الخطوات الست عشرة:
 *   1.  فحص الحالة (الخادم والقاعدة).
 *   2.  زائر يتصفح المنتجات.
 *   3.  تسجيل حساب زبون.
 *   4.  إنشاء سلة مربوطة بالحساب.
 *   5.  محاولة إضافة منتج نفد (مرفوضة بـ 409).
 *   6.  إضافة منتجين إلى السلة.
 *   7.  خيارات الشحن والدفع من الإضافات.
 *   8.  تسعير الطلب قبل الشراء.
 *   9.  إتمام الشراء بالدفع عند الاستلام، ونقص المخزون.
 *   10. نفس السلة مرة ثانية (409، لا طلب مكرر).
 *   11. الزبون يرى طلباته.
 *   12. المالك يؤكد الطلب.
 *   13. المالك يشحن الطلب.
 *   14. انتقال غير مسموح في الحالات (409).
 *   15. التسليم واستلام النقود.
 *   16. شخص غريب يحاول فتح الطلب (404).
 */

const BASE = `http://localhost:${process.env.PORT ?? 3000}`;
// مفتاح المالك من .env، يُرسل في ترويسة x-api-key لعمليات المالك.
const OWNER = { "x-api-key": process.env.OWNER_API_KEY };
// يحوّل الدراهم إلى نص بالدينار: 18500 يصبح "18.500 LYD".
const lyd = (dirhams) => `${(dirhams / 1000).toFixed(3)} LYD`;
let step = 0;

/**
 * يرسل طلباً إلى الـ API ويرجع { status, body }.
 * fetch مدمجة في Node 24، فلا نحتاج مكتبة. ونضيف Content-Type فقط إن كان هناك جسم.
 */
async function call(method, path, { body, headers } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** يطبع رقم الخطوة وعنوانها ورمز الحالة، وسطر ملخص اختياري. */
function show(title, res, summary) {
  step++;
  console.log(`\n${step}. ${title}  ->  HTTP ${res.status}`);
  if (summary) console.log(`   ${summary}`);
}

async function main() {
  // 1. الخادم والقاعدة يعملان.
  const health = await call("GET", "/health");
  show("Health check (server + database)", health, JSON.stringify(health.body));

  // 2. زائر يتصفح المنتجات (دون أي دخول). نبحث عن ثلاثة منتجات بالـ slug لنستخدمها لاحقاً.
  const catalogue = await call("GET", "/products");
  show("Browse the catalogue as a visitor", catalogue, `${catalogue.body.length} products`);
  const coffee = catalogue.body.find((p) => p.slug === "arabic-coffee-250g");
  const glasses = catalogue.body.find((p) => p.slug === "tea-glasses-6");
  const mint = catalogue.body.find((p) => p.slug === "mint-tea-200g");
  if (!coffee || !glasses || !mint) throw new Error("Run `npm run seed` first.");

  // 3. تسجيل حساب. البريد فيه الوقت الحالي (Date.now)، فيكون جديداً في كل تشغيل.
  const email = `demo-${Date.now()}@example.ly`;
  const reg = await call("POST", "/customers/register", {
    body: { email, password: "demo-password-1", name: "Fatima", phone: "0913334455" },
  });
  // حد التسجيل: 5 حسابات في الساعة لكل عنوان. التشغيل المتكرر قد يصل إليه.
  if (reg.status === 429) {
    throw new Error(
      "Registration limit reached (5 new accounts per hour per IP - the framework's anti-abuse limit). " +
        "Wait for the limit window to pass (the counters are shared in PostgreSQL), or reset the database, then run the scenario again."
    );
  }
  show("Register a customer account", reg, `customer ${reg.body.customer.email}, token issued`);
  // التوكن يُرسل مع كل طلب تالٍ في ترويسة Authorization.
  const auth = { authorization: `Bearer ${reg.body.token}` };

  // 4. سلة جديدة، مربوطة بالحساب لأن الطلب يحمل التوكن.
  const cart = await call("POST", "/carts", { headers: auth });
  show("Create a cart (linked to the account)", cart, `cart ${cart.body.id}`);

  // 5. محاولة إضافة منتج مخزونه 0: الرد 409 "Insufficient stock".
  const soldOut = await call("POST", `/carts/${cart.body.id}/items`, {
    headers: auth,
    body: { productId: mint.id, quantity: 1 },
  });
  show("Try to add an out-of-stock product", soldOut, soldOut.body.error.message);

  // 6. إضافة قهوتين وطقم كاسات. كل إضافة ترجع السلة كاملة بمجموعها.
  await call("POST", `/carts/${cart.body.id}/items`, { headers: auth, body: { productId: coffee.id, quantity: 2 } });
  const filled = await call("POST", `/carts/${cart.body.id}/items`, {
    headers: auth,
    body: { productId: glasses.id, quantity: 1 },
  });
  show("Add 2 x coffee and 1 x tea glasses", filled, `cart total ${lyd(filled.body.total)}`);

  // 7. طرق الشحن والدفع التي تقدمها الإضافات المثبتة في app.js.
  const options = await call("GET", "/checkout/options");
  show(
    "Checkout options offered by the installed plugins",
    options,
    `shipping: ${options.body.shippingMethods.map((m) => m.id).join(", ")} | payment: ${options.body.paymentMethods.map((m) => m.id).join(", ")}`
  );

  // 8. تسعير الطلب قبل الشراء (بلا أي أثر جانبي).
  const quote = await call("POST", "/checkout/quote", {
    headers: auth,
    body: { cartId: cart.body.id, shippingAddress: "Tripoli, Al-Andalus", shippingMethod: "flat-rate" },
  });
  show("Price the order with standard delivery", quote, `subtotal ${lyd(quote.body.subtotal)} + shipping ${lyd(quote.body.shippingCost)} = ${lyd(quote.body.total)}`);

  // 9. إتمام الشراء بالدفع عند الاستلام، ثم نقارن مخزون القهوة قبل الطلب وبعده (ينقص 2).
  const stockBefore = (await call("GET", `/inventory/${coffee.id}`)).body.quantity;
  const order = await call("POST", "/orders", {
    headers: auth,
    body: {
      cartId: cart.body.id,
      contactName: "Fatima",
      contactPhone: "0913334455",
      shippingAddress: "Tripoli, Al-Andalus",
      shippingMethod: "flat-rate",
      paymentMethod: "cod",
    },
  });
  show("Place the order (cash on delivery)", order, `order ${order.body.id}, total ${lyd(order.body.total)}, payment ${order.body.paymentStatus}: "${order.body.payment.instructions}"`);
  const stockAfter = (await call("GET", `/inventory/${coffee.id}`)).body.quantity;
  console.log(`   coffee stock: ${stockBefore} -> ${stockAfter}`);

  // 10. نفس السلة مرة ثانية، كضغطة مزدوجة على "تأكيد الطلب": الرد 409، ولا طلب ثانٍ.
  const again = await call("POST", "/orders", {
    headers: auth,
    body: { cartId: cart.body.id, contactName: "Fatima", contactPhone: "0913334455", shippingAddress: "Tripoli, Al-Andalus", shippingMethod: "flat-rate", paymentMethod: "cod" },
  });
  show("Submit the same cart again (double click)", again, again.body.error.message);

  // 11. الزبون يرى طلباته هو فقط.
  const mine = await call("GET", "/orders", { headers: auth });
  show("Customer lists their own orders", mine, `${mine.body.length} order(s)`);

  // 12 و 13. المالك يؤكد الطلب ثم يشحنه.
  const confirmed = await call("PATCH", `/orders/${order.body.id}/status`, { headers: OWNER, body: { status: "confirmed" } });
  show("Owner confirms the order", confirmed, `status ${confirmed.body.status}`);
  const shipped = await call("PATCH", `/orders/${order.body.id}/status`, { headers: OWNER, body: { status: "shipped" } });
  show("Owner marks it shipped", shipped, `status ${shipped.body.status}`);
  // 14. انتقال غير مسموح في آلة الحالات (من shipped إلى pending): الرد 409.
  const back = await call("PATCH", `/orders/${order.body.id}/status`, { headers: OWNER, body: { status: "pending" } });
  show("Owner tries an invalid transition (shipped -> pending)", back, back.body.error.message);
  // 15. التسليم، ثم تسجيل الدفع بعد استلام النقود.
  const delivered = await call("PATCH", `/orders/${order.body.id}/status`, { headers: OWNER, body: { status: "delivered" } });
  const paid = await call("PATCH", `/orders/${order.body.id}/payment`, { headers: OWNER, body: { status: "paid" } });
  show("Delivered and cash collected", paid, `status ${delivered.body.status}, payment ${paid.body.paymentStatus}`);

  // 16. شخص بلا توكن ولا هاتف الطلب: الرد 404، فلا يعرف حتى أن الطلب موجود.
  const stranger = await call("GET", `/orders/${order.body.id}`);
  show("A stranger tries to open the order", stranger, stranger.body.error.message);

  console.log("\nScenario finished.");
}

main().catch((err) => {
  console.error(`\nScenario failed: ${err.message}`);
  process.exitCode = 1;
});
