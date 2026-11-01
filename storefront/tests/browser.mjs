// اختبار شامل لموقع AMA في متصفح حقيقي (End-to-End): يشغّل متصفحاً من عائلة Chromium
// (Edge أو Chrome أو Chromium) بلا واجهة (headless)، ويقوده في رحلة شراء كاملة عبر
// بروتوكول أدوات المطوّر (DevTools Protocol)، دون أي مكتبة اختبار.
// يلتقط صورة لكل صفحة، ويفشل عند أي خطأ JavaScript أو أي مخالفة لسياسة أمان المحتوى (CSP).
//
//   npm start            (في نافذة أخرى: الـ API والموقع يجب أن يعملا)
//   npm run test:browser
//
// الصور تُحفظ في storefront/tests/screenshots/. المتغير BROWSER_PATH يحدد متصفحاً معيناً،
// و SITE يختبر عنواناً آخر (الافتراضي http://localhost:5173).
// الاختبار ينشئ طلبات حقيقية وزبوناً حقيقياً: شغّله على قاعدة تجريبية، لا على قاعدة المتجر.
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import dotenv from "dotenv";

// مفتاح المالك (لمنتج فحص XSS في الخطوة 10) من متغيرات البيئة أو من storefront/.env.
dotenv.config({ quiet: true, path: join(import.meta.dirname, "..", ".env") });
const OWNER_KEY = process.env.OWNER_API_KEY;

const OUT = join(import.meta.dirname, "screenshots");
mkdirSync(OUT, { recursive: true });
const SITE = process.env.SITE ?? "http://localhost:5173";
// الـ API افتراضياً على المنفذ 3000 بنفس عنوان الموقع. اضبط API=http://host:port لإعداد آخر.
const API = process.env.API ?? `${new URL(SITE).protocol}//${new URL(SITE).hostname}:3000`;

/**
 * يجد متصفحاً على الجهاز: من BROWSER_PATH إن ضُبط، وإلا يجرّب المسارات المعتادة.
 * في Windows يفحص وجود الملف، وفي Linux يسأل الطرفية بـ "command -v" إن كان الأمر موجوداً.
 */
function findBrowser() {
  if (process.env.BROWSER_PATH) return process.env.BROWSER_PATH;
  const candidates =
    process.platform === "win32"
      ? [
          "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
          "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
          "C:/Program Files/Google/Chrome/Application/chrome.exe",
        ]
      : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];
  for (const c of candidates) {
    if (process.platform === "win32" ? existsSync(c) : (() => { try { return execSync(`command -v ${c}`, { stdio: "pipe" }).length > 0; } catch { return false; } })()) return c;
  }
  throw new Error("No Edge/Chrome/Chromium found - set BROWSER_PATH to your browser executable.");
}

// منفذ أدوات المطوّر عشوائي في كل تشغيل، فلا يتصل الاختبار أبداً بمتصفح بقي من تشغيل سابق.
const PORT = 9300 + Math.floor(Math.random() * 600);
// ملف تعريف (Profile) جديد ومؤقت: لا يلمس متصفح المستخدم ولا بياناته.
const profile = mkdtempSync(join(tmpdir(), "ama-browser-test-"));
const browser = spawn(findBrowser(), [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-sandbox", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, "--window-size=1366,900", "about:blank",
], { stdio: "ignore", detached: process.platform !== "win32" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ننتظر حتى يجهز المتصفح (حتى 10 ثوانٍ: 50 محاولة كل 200 ملي ثانية)، ونأخذ أول صفحة مفتوحة فيه.
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try {
    target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === "page");
  } catch {}
}
if (!target) throw new Error("The browser did not start");

// الاتصال بالصفحة عبر WebSocket (مدمج في Node 24). كل أمر نرسله يحمل رقماً (id)، والرد
// يعود بنفس الرقم، فنحفظ لكل رقم وعده المعلق في pending.
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();
// كل مشكلة يلاحظها المتصفح تُجمع هنا: أخطاء JavaScript، وتحذيرات السجل (ومنها مخالفات CSP)،
// و console.error. والاستثناء الوحيد: 404 المتوقع عند تتبع طلب برقم هاتف خاطئ (الخطوة 7).
const problems = [];
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method === "Runtime.exceptionThrown") {
    problems.push(`JS exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
  } else if (msg.method === "Log.entryAdded" && ["error", "warning"].includes(msg.params.entry.level)
             && !(msg.params.entry.text.includes("status of 404") && (msg.params.entry.url ?? "").includes("phone=0000000"))) {
    problems.push(`${msg.params.entry.level}: ${msg.params.entry.text} ${msg.params.entry.url ?? ""}`);
  } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    problems.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(" ")}`);
  }
});
/** يرسل أمراً إلى المتصفح، ويرجع وعداً بالرد. */
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
// نفعّل الأحداث التي نحتاجها: تحميل الصفحات، وتنفيذ الكود، والسجل.
await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");
// عنوان API غير افتراضي يُعطى للموقع بنفس الطريقة التي يُعطى بها في النشر الحقيقي
// (window.AMA_API_BASE، انظر web/js/config.js)، ويُحقن قبل تحميل أي صفحة.
if (process.env.API) await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.AMA_API_BASE = ${JSON.stringify(API)};` });

/** ينفّذ تعبير JavaScript داخل الصفحة، وينتظر نتيجته إن كانت وعداً، ويرجع قيمتها. */
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description}`);
  return r.result.value;
};
/** ينتظر حتى يصبح التعبير صحيحاً في الصفحة (كل 100 ملي ثانية)، أو يفشل بعد المهلة. */
async function waitFor(expr, what, timeout = 8000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await evaluate(`Boolean(${expr})`)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for: ${what}`);
}
/** يفتح صفحة من الموقع وينتظر اكتمال تحميلها. */
async function go(path) {
  await send("Page.navigate", { url: SITE + path });
  await waitFor(`document.readyState === "complete"`, `load ${path}`);
}
// الصفحات التي يكون عرضها أكبر من النافذة (تمرير أفقي = خلل في التصميم)، مع أول العناصر المسببة.
const overflow = [];
/** يلتقط صورة للصفحة (كاملة حتى 4000 بكسل طولاً)، ويسجل أي تمرير أفقي قبلها. */
async function shot(name, fullPage = true) {
  const widths = await evaluate(`[document.documentElement.scrollWidth, window.innerWidth]`);
  if (widths[0] > widths[1]) {
    const culprit = await evaluate(`[...document.querySelectorAll("body *")].filter(e => e.getBoundingClientRect().left < -1 || e.getBoundingClientRect().right > window.innerWidth + 1).slice(0,3).map(e => e.tagName + "." + e.className).join(" | ")`);
    overflow.push(`${name}: page ${widths[0]}px wide vs window ${widths[1]}px -> ${culprit}`);
  }
  let clip;
  if (fullPage) {
    const { contentSize } = await send("Page.getLayoutMetrics");
    clip = { x: 0, y: 0, width: Math.ceil(contentSize.width), height: Math.min(Math.ceil(contentSize.height), 4000), scale: 1 };
  }
  const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, ...(clip ? { clip } : {}) });
  writeFileSync(join(OUT, `e2e-${name}.png`), Buffer.from(data, "base64"));
}
const log = (m) => console.log(m);

try {
  // 1. الرئيسية: 16 بطاقة منتج، وأزرار المنتجات التي نفدت معطلة.
  await go("/index.html");
  await waitFor(`document.querySelectorAll(".card").length >= 16`, "16 product cards");
  log(`home: ${await evaluate(`document.querySelectorAll(".card").length`)} cards, out-of-stock buttons disabled: ${await evaluate(`[...document.querySelectorAll("[data-add]")].filter(b=>b.disabled).length`)}`);
  await shot("1-home");

  // 2. التصفية بالقسم (الضغط على "سماعات")، ثم البحث بكلمة "باور".
  await evaluate(`[...document.querySelectorAll(".chip")].find(c => c.textContent.includes("سماعات")).click()`);
  await waitFor(`document.querySelector(".section-head h2")?.textContent === "سماعات"`, "category page");
  log(`category 'سماعات': ${await evaluate(`document.querySelectorAll(".card").length`)} cards`);
  await go("/index.html?q=" + encodeURIComponent("باور"));
  await waitFor(`document.querySelectorAll(".card").length > 0`, "search results");
  log(`search 'باور': ${await evaluate(`document.querySelectorAll(".card").length`)} cards`);

  // 3. ضيف يضيف منتجاً من الرئيسية: رقم السلة في الرأس يصبح 1.
  await go("/index.html");
  await waitFor(`document.querySelector("[data-add]:not([disabled])")`, "add buttons");
  await evaluate(`[...document.querySelectorAll(".card")].find(c => c.textContent.includes("شاحن سريع 20")).querySelector("[data-add]").click()`);
  await waitFor(`document.querySelector("[data-cart-count]")?.textContent === "1"`, "cart badge = 1");
  log(`add from home: badge=${await evaluate(`document.querySelector("[data-cart-count]").textContent`)}, toast="${await evaluate(`document.querySelector(".toast")?.textContent`)}"`);

  // 4. صفحة منتج: نجد رقم الساعة الذكية من الـ API، ونجرّب زرّي الكمية، ثم نضيف.
  const watchId = await evaluate(`fetch("${API}/products?limit=100").then(r=>r.json()).then(ps=>ps.find(p=>p.slug==="sport-smartwatch").id)`);
  await go(`/product.html?id=${watchId}`);
  await waitFor(`document.querySelector("[data-add]")`, "product page");
  // زر + ثم زر - يتركان الكمية 1 (فتبقى السلة تحت حد التوصيل المجاني، 500 دينار).
  await evaluate(`document.querySelector('[data-step="1"]').click()`);
  log(`stepper after +: ${await evaluate(`document.querySelector("[data-qty]").value`)}`);
  await evaluate(`document.querySelector('[data-step="-1"]').click()`);
  await evaluate(`document.querySelector("[data-add]").click()`);
  await waitFor(`document.querySelector("[data-cart-count]")?.textContent === "2"`, "cart badge = 2");
  log(`product page: title="${await evaluate(`document.querySelector("h1").textContent`)}", badge=2, button re-enabled: ${await evaluate(`!document.querySelector("[data-add]").disabled`)}`);
  await shot("2-product");

  // 5. السلة: سطران.
  await go("/cart.html");
  await waitFor(`document.querySelectorAll(".cart-line").length === 2`, "2 cart lines");
  log(`cart: ${await evaluate(`document.querySelectorAll(".cart-line").length`)} lines, summary: ${await evaluate(`document.querySelector(".summary .total").textContent.replace(/\\s+/g," ")`)}`);
  await shot("3-cart");

  // 6. إتمام الطلب: إرسال فارغ (رسائل الحقول)، ثم ملء البيانات واختيار بنغازي (40 دينار)،
  //    ثم التبديل إلى الاستلام من المحل (مجاناً) والعودة (المدينة المختارة لا تضيع)، ثم الإرسال.
  //    dispatchEvent يطلق حدث input أو change يدوياً، كأن المستخدم كتب أو اختار.
  await go("/checkout.html");
  await waitFor(`document.querySelector("[data-form]")`, "checkout form");
  await evaluate(`document.querySelector("[data-submit]").click()`);
  log(`checkout empty submit -> field errors: ${await evaluate(`[...document.querySelectorAll(".field.invalid")].length`)}`);
  await evaluate(`(() => { const f=document.querySelector("[data-form]");
    for (const [n,v] of [["contactName","فاطمة علي"],["contactPhone","0913334455"]]) { f[n].value=v; f[n].dispatchEvent(new Event("input",{bubbles:true})); }
    const c=document.querySelector("#city"); c.value="بنغازي"; c.dispatchEvent(new Event("change",{bubbles:true})); })()`);
  await waitFor(`document.querySelector("[data-shipping]").textContent.includes("40")`, "Benghazi delivery price");
  log(`checkout quote for بنغازي: shipping=${await evaluate(`document.querySelector("[data-shipping]").textContent`)}, total=${await evaluate(`document.querySelector("[data-total]").textContent`)}`);
  await evaluate(`(() => { const r=[...document.querySelectorAll('[name="shippingMethod"]')].find(x=>x.value==="pickup"); r.checked=true; r.dispatchEvent(new Event("change",{bubbles:true})); })()`);
  await waitFor(`document.querySelector("[data-shipping]").textContent === "مجاناً"`, "pickup = free");
  log(`checkout pickup: shipping=${await evaluate(`document.querySelector("[data-shipping]").textContent`)}, address hidden=${await evaluate(`document.querySelector("[data-delivery]").classList.contains("hidden")`)}`);
  await evaluate(`(() => { const r=[...document.querySelectorAll('[name="shippingMethod"]')].find(x=>x.value==="city-rate"); r.checked=true; r.dispatchEvent(new Event("change",{bubbles:true})); })()`);
  await waitFor(`document.querySelector("[data-shipping]").textContent.includes("40")`, "back to city delivery");
  await evaluate(`(() => { const a=document.querySelector("[data-form]").shippingAddress; a.value="الفويهات، شارع دبي، قرب الجامع"; a.dispatchEvent(new Event("input",{bubbles:true})); })()`);
  log(`checkout errors left after filling the form: ${await evaluate(`document.querySelectorAll(".field.invalid").length`)}`);
  await shot("4-checkout");
  await evaluate(`document.querySelector("[data-submit]").click()`);
  await waitFor(`document.querySelector(".order-id")`, "order confirmation");
  const orderId = await evaluate(`document.querySelector(".order-id").textContent`);
  log(`order placed: ${orderId}; page says: ${await evaluate(`document.querySelector(".big").textContent`)}`);
  log(`after order: cart badge=${await evaluate(`document.querySelector("[data-cart-count]").textContent`)}`);
  await shot("5-success");

  // 7. التتبع كضيف: بهاتف خاطئ (رسالة "لم نجد")، ثم بالهاتف الصحيح (بطاقة الطلب).
  await go(`/track.html?id=${orderId}&phone=0000000`);
  await waitFor(`document.querySelector("[data-result] .alert")`, "wrong phone message");
  log(`track wrong phone: ${await evaluate(`document.querySelector("[data-result]").textContent.trim()`)}`);
  await go(`/track.html?id=${orderId}&phone=0913334455`);
  await waitFor(`document.querySelector(".order-card")`, "tracked order");
  log(`track right phone: status="${await evaluate(`document.querySelector(".status").textContent`)}"`);
  await shot("6-track");

  // 8. تسجيل حساب جديد، ثم الشراء كزبون (البيانات تُملأ من الحساب)، ثم صفحة "طلباتي".
  //    البريد فيه الوقت الحالي، فيكون جديداً في كل تشغيل.
  const email = `e2e-${Date.now()}@example.ly`;
  await go("/account.html");
  await evaluate(`[...document.querySelectorAll("[data-tab]")].find(b=>b.dataset.tab==="register").click()`);
  await waitFor(`document.querySelector("[data-register]")`, "register form");
  await evaluate(`(() => { const f=document.querySelector("[data-register]"); f.name.value="سالم"; f.email.value="${email}"; f.phone.value="0925556677"; f.password.value="very-secret-1"; f.requestSubmit(); })()`);
  await waitFor(`location.pathname.endsWith("orders.html")`, "redirect to orders after register");
  await waitFor(`document.querySelector(".page-title")`, "orders page");
  log(`after register: header shows "${await evaluate(`[...document.querySelectorAll(".nav a")][1].textContent.trim()`)}", orders: ${await evaluate(`document.querySelectorAll(".order-card").length`)}`);
  await go(`/product.html?id=${watchId}`);
  await waitFor(`document.querySelector("[data-add]")`, "product page");
  await evaluate(`document.querySelector("[data-add]").click()`);
  await waitFor(`document.querySelector("[data-cart-count]")?.textContent === "1"`, "badge 1");
  await go("/checkout.html");
  await waitFor(`document.querySelector("[data-form]")`, "checkout form (customer)");
  log(`checkout prefilled for customer: name="${await evaluate(`document.querySelector("#name").value`)}", phone="${await evaluate(`document.querySelector("#phone").value`)}"`);
  await evaluate(`(() => { const c=document.querySelector("#city"); c.value="تاجوراء"; c.dispatchEvent(new Event("change",{bubbles:true}));
    document.querySelector("[data-form]").shippingAddress.value="تاجوراء، الحميدية"; })()`);
  await waitFor(`document.querySelector("[data-shipping]").textContent.includes("5")`, "Tajoura price");
  await evaluate(`document.querySelector("[data-submit]").click()`);
  await waitFor(`document.querySelector(".order-id")`, "customer order confirmation");
  await go("/orders.html");
  await waitFor(`document.querySelectorAll(".order-card").length === 1`, "1 order in My orders");
  log(`my orders: ${await evaluate(`document.querySelectorAll(".order-card").length`)} order, city: ${await evaluate(`document.querySelector(".items-table").textContent.includes("تاجوراء")`)}`);
  await shot("7-my-orders");

  // 9. الرئيسية على شاشة هاتف (390×844).
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await go("/index.html");
  await waitFor(`document.querySelectorAll(".card").length >= 16`, "mobile home");
  await shot("8-mobile", false);

  // 10. الأمان: منتج اسمه يحتوي HTML يجب أن يظهر نصاً، ولا يُنفَّذ أبداً كـ HTML (حماية من XSS).
  //     ننشئ منتج الفحص بمفتاح المالك، ونحذفه بعد الفحص مهما كانت النتيجة (finally).
  //     إن نُفّذ الاسم كـ HTML، لظهر عنصر img بمصدر "x"، ولضبط onerror المتغير window.__xss.
  if (OWNER_KEY) {
    const ownerHeaders = { "content-type": "application/json", "x-api-key": OWNER_KEY };
    const created = await fetch(`${API}/products`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ name: `<img src=x onerror="window.__xss=1">xss-probe`, slug: `xss-probe-${Date.now()}`, price: 1000 }),
    });
    if (created.status !== 201) throw new Error(`could not create the XSS probe product: HTTP ${created.status}`);
    const probe = await created.json();
    try {
      await go("/index.html?q=xss-probe");
      await waitFor(`document.querySelectorAll(".card").length === 1`, "XSS probe card");
      const r = await evaluate(`({ markup: document.querySelectorAll(".card img[src='x'], .card script").length,
        ran: window.__xss === 1, asText: document.querySelector(".card .name").textContent.includes("<img") })`);
      log(`XSS check: markup injected=${r.markup}, script ran=${r.ran}, name shown as text=${r.asText}`);
      if (r.markup || r.ran || !r.asText) throw new Error("XSS: a product name was rendered as HTML");
    } finally {
      await fetch(`${API}/products/${probe.id}`, { method: "DELETE", headers: ownerHeaders });
    }
  } else {
    log("XSS check skipped: OWNER_API_KEY is not set (storefront/.env or environment)");
  }
} catch (err) {
  // أي خطوة فشلت: صورة للحظة الفشل لتسهيل معرفة السبب، ورمز خروج 1.
  console.log("E2E FAILED:", err.message);
  await shot("failure", false).catch(() => {});
  process.exitCode = 1;
} finally {
  console.log(overflow.length ? `HORIZONTAL OVERFLOW:\n  ${overflow.join("\n  ")}` : "layout: no horizontal overflow on any page");
  console.log(problems.length ? `BROWSER PROBLEMS (${problems.length}):\n  ${problems.join("\n  ")}` : "browser console: no errors, no CSP violations");
  ws.close();
  // نوقف المتصفح كله مع كل عملياته الفرعية (وإلا بقيت تعمل في الخلفية).
  // في Windows بأمر taskkill مع /T (الشجرة كاملة)، وفي Linux بإشارة لمجموعة العمليات (-pid).
  try {
    if (process.platform === "win32") execSync(`taskkill /T /F /PID ${browser.pid}`, { stdio: "ignore" });
    else process.kill(-browser.pid, "SIGKILL");
  } catch {}
  if (problems.some((p) => !p.includes("status of 404"))) process.exitCode = 1;
}
