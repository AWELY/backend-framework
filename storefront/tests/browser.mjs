// Browser end-to-end test for the AMA website: drives a real headless
// Chromium-family browser (Edge, Chrome or Chromium) through a full shopping
// journey via the DevTools Protocol - no test library. Takes a screenshot of
// every page and fails on any JS exception or Content-Security-Policy violation.
//
//   npm start            (in another terminal - API + website must be running)
//   npm run test:browser
//
// Screenshots go to storefront/tests/screenshots/. Set BROWSER_PATH to use a
// specific browser; SITE to test another address (default http://localhost:5173).
// It creates real orders and a customer - run it against a demo database.
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const OUT = join(import.meta.dirname, "screenshots");
mkdirSync(OUT, { recursive: true });
const SITE = process.env.SITE ?? "http://localhost:5173";
const API = `${new URL(SITE).protocol}//${new URL(SITE).hostname}:3000`;

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

// A random DevTools port per run, so a leftover browser from an earlier run can never be picked up.
const PORT = 9300 + Math.floor(Math.random() * 600);
const profile = mkdtempSync(join(tmpdir(), "ama-browser-test-"));
const browser = spawn(findBrowser(), [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-sandbox", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, "--window-size=1366,900", "about:blank",
], { stdio: "ignore", detached: process.platform !== "win32" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try {
    target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === "page");
  } catch {}
}
if (!target) throw new Error("The browser did not start");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();
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
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");

const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description}`);
  return r.result.value;
};
async function waitFor(expr, what, timeout = 8000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await evaluate(`Boolean(${expr})`)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for: ${what}`);
}
async function go(path) {
  await send("Page.navigate", { url: SITE + path });
  await waitFor(`document.readyState === "complete"`, `load ${path}`);
}
const overflow = [];
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
  // 1. Home
  await go("/index.html");
  await waitFor(`document.querySelectorAll(".card").length >= 16`, "16 product cards");
  log(`home: ${await evaluate(`document.querySelectorAll(".card").length`)} cards, out-of-stock buttons disabled: ${await evaluate(`[...document.querySelectorAll("[data-add]")].filter(b=>b.disabled).length`)}`);
  await shot("1-home");

  // 2. Category filter + search
  await evaluate(`[...document.querySelectorAll(".chip")].find(c => c.textContent.includes("سماعات")).click()`);
  await waitFor(`document.querySelector(".section-head h2")?.textContent === "سماعات"`, "category page");
  log(`category 'سماعات': ${await evaluate(`document.querySelectorAll(".card").length`)} cards`);
  await go("/index.html?q=" + encodeURIComponent("باور"));
  await waitFor(`document.querySelectorAll(".card").length > 0`, "search results");
  log(`search 'باور': ${await evaluate(`document.querySelectorAll(".card").length`)} cards`);

  // 3. Add from home (guest)
  await go("/index.html");
  await waitFor(`document.querySelector("[data-add]:not([disabled])")`, "add buttons");
  await evaluate(`[...document.querySelectorAll(".card")].find(c => c.textContent.includes("شاحن سريع 20")).querySelector("[data-add]").click()`);
  await waitFor(`document.querySelector("[data-cart-count]")?.textContent === "1"`, "cart badge = 1");
  log(`add from home: badge=${await evaluate(`document.querySelector("[data-cart-count]").textContent`)}, toast="${await evaluate(`document.querySelector(".toast")?.textContent`)}"`);

  // 4. Product page, quantity 2
  const watchId = await evaluate(`fetch("${API}/products?limit=100").then(r=>r.json()).then(ps=>ps.find(p=>p.slug==="sport-smartwatch").id)`);
  await go(`/product.html?id=${watchId}`);
  await waitFor(`document.querySelector("[data-add]")`, "product page");
  // quantity stepper: + then - leaves 1 (cart stays under the 500 LYD free-delivery line)
  await evaluate(`document.querySelector('[data-step="1"]').click()`);
  log(`stepper after +: ${await evaluate(`document.querySelector("[data-qty]").value`)}`);
  await evaluate(`document.querySelector('[data-step="-1"]').click()`);
  await evaluate(`document.querySelector("[data-add]").click()`);
  await waitFor(`document.querySelector("[data-cart-count]")?.textContent === "2"`, "cart badge = 2");
  log(`product page: title="${await evaluate(`document.querySelector("h1").textContent`)}", badge=2, button re-enabled: ${await evaluate(`!document.querySelector("[data-add]").disabled`)}`);
  await shot("2-product");

  // 5. Cart
  await go("/cart.html");
  await waitFor(`document.querySelectorAll(".cart-line").length === 2`, "2 cart lines");
  log(`cart: ${await evaluate(`document.querySelectorAll(".cart-line").length`)} lines, summary: ${await evaluate(`document.querySelector(".summary .total").textContent.replace(/\\s+/g," ")`)}`);
  await shot("3-cart");

  // 6. Checkout: validation, city quote, pickup toggle, submit
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

  // 7. Track as guest (wrong phone, then right phone)
  await go(`/track.html?id=${orderId}&phone=0000000`);
  await waitFor(`document.querySelector("[data-result] .alert")`, "wrong phone message");
  log(`track wrong phone: ${await evaluate(`document.querySelector("[data-result]").textContent.trim()`)}`);
  await go(`/track.html?id=${orderId}&phone=0913334455`);
  await waitFor(`document.querySelector(".order-card")`, "tracked order");
  log(`track right phone: status="${await evaluate(`document.querySelector(".status").textContent`)}"`);
  await shot("6-track");

  // 8. Register, buy as customer, see "My orders"
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

  // 9. Mobile layout of the home page
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await go("/index.html");
  await waitFor(`document.querySelectorAll(".card").length >= 16`, "mobile home");
  await shot("8-mobile", false);

  // 10. Security: product with a script in its name must render as text
  log(`XSS check: any <script> injected in cards? ${await evaluate(`document.querySelectorAll(".card script").length`)}`);
} catch (err) {
  console.log("E2E FAILED:", err.message);
  await shot("failure", false).catch(() => {});
  process.exitCode = 1;
} finally {
  console.log(overflow.length ? `HORIZONTAL OVERFLOW:\n  ${overflow.join("\n  ")}` : "layout: no horizontal overflow on any page");
  console.log(problems.length ? `BROWSER PROBLEMS (${problems.length}):\n  ${problems.join("\n  ")}` : "browser console: no errors, no CSP violations");
  ws.close();
  // Kill the WHOLE browser process tree (child processes otherwise keep running).
  try {
    if (process.platform === "win32") execSync(`taskkill /T /F /PID ${browser.pid}`, { stdio: "ignore" });
    else process.kill(-browser.pid, "SIGKILL");
  } catch {}
  if (problems.some((p) => !p.includes("status of 404"))) process.exitCode = 1;
}
