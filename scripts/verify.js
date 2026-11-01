"use strict";

/**
 * أمر واحد يتأكد أن كل شيء ما زال يعمل، من البداية إلى النهاية:
 *
 *   npm run verify
 *
 *   0. المتطلبات     : Node 24 أو أحدث، وملف .env، وقاعدة اختبار يمكن الوصول إليها.
 *   1. البناء        : TypeScript يترجم دون أخطاء.
 *   2. الاختبارات    : كل اختبارات الوحدة والتكامل (على PostgreSQL حقيقية).
 *   3. أداة CLI      : إنشاء متجر جديد، ثم تثبيته، ثم migrate، ثم تشغيله، ثم استدعاؤه.
 *   4. المتجر التجريبي: migrate، ثم البيانات الأولية، ثم التشغيل، ثم سيناريو الشراء ذو الـ 16 خطوة.
 *   5. متجر ماء      : الـ API والموقع: الصفحات، وترويسات الأمان، والصور، والمدن، و CORS.
 *
 * كل خطوة تستخدم قاعدة البيانات تستخدم TEST_DATABASE_URL (وتُمسح)، وليس بيانات التطوير أبداً.
 * المجلدات المؤقتة تُحذف في النهاية، نجح الفحص أو فشل.
 * في النهاية يطبع قائمة PASS أو FAIL لكل خطوة، ثم ALL CHECKS PASSED إن نجح كل شيء.
 */

require("dotenv").config({ quiet: true });
const { spawn, spawnSync } = require("node:child_process");
const { existsSync, rmSync } = require("node:fs");
const { join, resolve } = require("node:path");
const net = require("node:net");
const { randomBytes } = require("node:crypto");

// مجلد المشروع، وقاعدة الاختبار، ونتائج الخطوات بالترتيب.
const ROOT = resolve(__dirname, "..");
const TEST_DB = process.env.TEST_DATABASE_URL;
const results = [];

/** سر عشوائي جديد (64 حرفاً سداسياً) للمتاجر المؤقتة. */
const secret = () => randomBytes(32).toString("hex");

/**
 * يشغّل أمراً وينتظر انتهاءه. إن فشل (رمز خروج غير 0)، يرمي خطأ فيه آخر 15 سطراً من مخرجاته.
 * extraEnv: متغيرات بيئة إضافية لهذا الأمر فقط (مثل رابط القاعدة والمنفذ).
 */
function run(command, args, cwd, extraEnv = {}) {
  const options = { cwd, env: { ...process.env, ...extraEnv }, encoding: "utf8" };
  // في Windows الأمر npm ملف .cmd، ويجب تشغيله عبر الطرفية (shell). نمرره كنص أمر واحد
  // (معاملاتنا ثابتة من كتابتنا، لا من مستخدم)، فنتجنب تحذير Node رقم DEP0190 عن
  // المعاملات غير المحمية في الطرفية.
  const res =
    command === "npm" && process.platform === "win32"
      ? spawnSync(`npm ${args.join(" ")}`, { ...options, shell: true })
      : spawnSync(command, args, options);
  if (res.status !== 0) {
    const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim().split("\n").slice(-15).join("\n");
    throw new Error(`"${command} ${args.join(" ")}" failed:\n${output}`);
  }
  return res.stdout ?? "";
}

/**
 * منفذ فارغ: نفتح خادماً على المنفذ 0 (فيختار النظام منفذاً فارغاً)، نقرأ رقمه، ثم نغلقه.
 * هكذا لا تتعارض خوادم الفحص مع خوادمك العاملة (مثل المتجر على 3000).
 */
function freePort() {
  return new Promise((ok) => {
    const srv = net.createServer().listen(0, () => {
      const { port } = srv.address();
      srv.close(() => ok(port));
    });
  });
}

/**
 * يشغّل node <file> كعملية منفصلة، وينتظر حتى يرد GET <probe> بـ 200 (الافتراضي: /health في الـ API).
 * يحاول 100 مرة كل 100 ملي ثانية (10 ثوانٍ). إن توقفت العملية مبكراً أو لم تجهز، يرمي خطأ بسجلها.
 */
async function startServer(file, cwd, env, probe) {
  const child = spawn(process.execPath, [file], { cwd, env: { ...process.env, ...env }, stdio: "pipe" });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const base = `http://localhost:${env.PORT}`;
  const probeUrl = probe ?? `${base}/health`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    try {
      if ((await fetch(probeUrl)).status === 200) return { child, base, log: () => log };
    } catch {
      // لم يبدأ الاستماع بعد
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await stopServer({ child });
  throw new Error(`server did not become healthy:\n${log}`);
}

/** يوقف خادماً، وينتظر حتى تنتهي العملية فعلاً (في Windows يبقى مجلدها مقفلاً حتى ذلك الحين). */
async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return;
  const exited = new Promise((ok) => server.child.once("exit", ok));
  server.child.kill();
  await exited;
}

/** يحذف مجلداً مؤقتاً، ويعيد المحاولة قليلاً إن كان Windows ما زال يقفل ملفاً فيه. */
function removeDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    console.log(`\n    warning: could not delete ${dir} (${err.code}) - delete it by hand`);
  }
}

/** يمسح كل جداول قاعدة الاختبار، فتبدأ كل خطوة من قاعدة نظيفة. */
async function resetTestDatabase() {
  const { Pool } = require(join(ROOT, "node_modules", "pg"));
  const pool = new Pool({ connectionString: TEST_DB });
  try {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  } finally {
    await pool.end();
  }
}

/**
 * ينفّذ خطوة فحص واحدة: يطبع رقمها واسمها، ثم PASS مع المدة وسطر تفاصيل، أو FAIL مع السبب.
 * لا يوقف البرنامج عند الفشل: يسجل النتيجة ويرجع false، والمستدعي يقرر هل يكمل.
 */
async function step(name, fn) {
  const started = Date.now();
  process.stdout.write(`\n[${results.length}] ${name} ... `);
  try {
    const detail = await fn();
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    results.push({ name, ok: true });
    console.log(`PASS (${seconds}s)${detail ? `\n    ${detail}` : ""}`);
    return true;
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL\n    ${String(err.message ?? err).split("\n").join("\n    ")}`);
    return false;
  }
}

async function main() {
  console.log("Verifying the Maa framework end to end.");

  // الخطوة 0: بدون هذه المتطلبات لا معنى لأي خطوة بعدها، فنتوقف إن فشلت.
  const ready = await step("prerequisites", async () => {
    const major = Number(process.versions.node.split(".")[0]);
    if (major < 24) throw new Error(`Node.js 24+ required, found ${process.version}`);
    if (!existsSync(join(ROOT, ".env"))) throw new Error("No .env file - copy .env.example to .env and fill it in.");
    if (!TEST_DB) throw new Error("TEST_DATABASE_URL is missing from .env.");
    // حماية: القاعدة ستُمسح، فيجب أن يحتوي اسمها كلمة test.
    if (!/test/i.test(new URL(TEST_DB).pathname)) {
      throw new Error("TEST_DATABASE_URL must point to a database whose name contains 'test' (it gets wiped).");
    }
    const { Pool } = require(join(ROOT, "node_modules", "pg"));
    const pool = new Pool({ connectionString: TEST_DB });
    try {
      const { rows } = await pool.query("SELECT version()");
      return `${process.version}, ${rows[0].version.split(",")[0]}`;
    } catch (err) {
      throw new Error(`Cannot reach the test database: ${err.message}\n(Is the PostgreSQL service running?)`);
    } finally {
      await pool.end();
    }
  });
  if (!ready) return;

  // الخطوة 1: الترجمة. إن فشلت، كل ما بعدها سيفشل، فنتوقف.
  const built = await step("build (TypeScript)", async () => {
    run("npm", ["run", "build"], ROOT);
  });
  if (!built) return;

  // الخطوة 2: كل الاختبارات. نقرأ الأرقام من ملخص node:test في آخر المخرجات (ℹ tests 77 ...).
  await step("unit + integration tests", async () => {
    const out = run("npm", ["test"], ROOT);
    const count = (label) => Number((out.match(new RegExp(`ℹ ${label} (\\d+)`)) ?? [])[1] ?? NaN);
    const [tests, pass, fail] = [count("tests"), count("pass"), count("fail")];
    if (fail !== 0 || !(pass > 0)) throw new Error(`tests: ${tests}, pass: ${pass}, fail: ${fail}`);
    return `${pass}/${tests} tests passed`;
  });

  // الخطوة 3: أداة CLI. اسم المتجر عشوائي (verify-store-xxxxxx) فلا يتعارض مع مجلد موجود،
  // والمجلد يُحذف في النهاية مهما حدث (finally).
  const storeName = `verify-store-${randomBytes(3).toString("hex")}`;
  const storeDir = resolve(ROOT, "..", storeName);
  await step("CLI: create a store, install, migrate, start, call it", async () => {
    let server;
    try {
      run(process.execPath, [join(ROOT, "cli", "index.js"), "create", storeName], ROOT);
      if (!existsSync(join(storeDir, ".env"))) throw new Error("the CLI did not write a .env");
      run("npm", ["install", "--loglevel=error"], storeDir);
      await resetTestDatabase();
      const env = { DATABASE_URL: TEST_DB, PORT: String(await freePort()) };
      const migrated = run("npm", ["run", "migrate", "--silent"], storeDir, env);
      if (!/migration\(s\) applied/.test(migrated)) throw new Error(`unexpected migrate output: ${migrated}`);
      server = await startServer("index.js", storeDir, env);
      // المتجر المولّد يجب أن يحتوي إضافة الدفع عند الاستلام من القالب.
      const options = await (await fetch(`${server.base}/checkout/options`)).json();
      if (!options.paymentMethods?.some((m) => m.id === "cod")) throw new Error("plugins are not installed in the generated store");
      return `generated ${storeName}, health OK, plugins OK`;
    } finally {
      await stopServer(server);
      removeDir(storeDir);
    }
  });

  // الخطوة 4: المتجر التجريبي، وسيناريو الشراء الكامل (scenario.js) يجب أن يطبع 16 خطوة بالضبط،
  // وسجل الخادم يجب أن يخلو من أي ERROR.
  const demoDir = join(ROOT, "examples", "demo-store");
  await step("demo store: migrate, seed, start, 16-step scenario", async () => {
    let server;
    try {
      // المتجر التجريبي يحمل نسخة من الإطار في node_modules: نحدّثها ليختبر البناء الحالي.
      rmSync(join(demoDir, "node_modules", "maa"), { recursive: true, force: true });
      run("npm", ["install", "--loglevel=error"], demoDir);
      await resetTestDatabase();
      const env = {
        DATABASE_URL: TEST_DB,
        PORT: String(await freePort()),
        OWNER_API_KEY: secret(),
        AUTH_TOKEN_SECRET: secret(),
      };
      run("npm", ["run", "migrate", "--silent"], demoDir, env);
      const seeded = run("npm", ["run", "seed", "--silent"], demoDir, env);
      if (!/Seeded \d+ record/.test(seeded)) throw new Error(`unexpected seed output: ${seeded}`);
      server = await startServer("index.js", demoDir, env);
      const out = run("npm", ["run", "scenario", "--silent"], demoDir, env);
      // نعدّ الأسطر التي تبدأ برقم ونقطة ("1. ..."، "2. ...")، وهي خطوات السيناريو.
      const steps = (out.match(/^\d+\. /gm) ?? []).length;
      if (!/Scenario finished/.test(out) || steps !== 16) throw new Error(`scenario ended after ${steps} steps:\n${out}`);
      if (/\bERROR\b/.test(server.log())) throw new Error(`server logged errors:\n${server.log()}`);
      return "16/16 steps, no server errors";
    } finally {
      await stopServer(server);
    }
  });
}

/**
 * الخطوة 5: متجر ماء (الـ API والموقع معاً، على منافذ فارغة وقاعدة الاختبار).
 * يفحص: الصفحات السبع ترد 200 ومعها CSP، والسكربتات بنوعها الصحيح، وعدم تسرب .env،
 * وصورة كل منتج موجودة فعلاً، والتوصيل حسب المدينة (ومنها تاجوراء)، وطلب CORS التمهيدي،
 * وأن كل سكربتات الموقع خالية من أخطاء الصياغة (node --check).
 */
async function storefrontStep() {
  const storeDir = join(ROOT, "storefront");
  let api;
  let web;
  try {
    // نسخة الإطار في المتجر تُحدَّث، كما في المتجر التجريبي.
    rmSync(join(storeDir, "node_modules", "maa"), { recursive: true, force: true });
    run("npm", ["install", "--loglevel=error"], storeDir);
    await resetTestDatabase();
    const apiPort = await freePort();
    const webPort = await freePort();
    const origin = `http://localhost:${webPort}`;
    const env = {
      DATABASE_URL: TEST_DB,
      PORT: String(apiPort),
      WEB_PORT: String(webPort),
      OWNER_API_KEY: secret(),
      AUTH_TOKEN_SECRET: secret(),
      CORS_ORIGIN: origin,
    };
    run("npm", ["run", "migrate", "--silent"], storeDir, env);
    const seeded = run("npm", ["run", "seed", "--silent"], storeDir, env);
    if (!/Seeded \d+ record/.test(seeded)) throw new Error(`unexpected seed output: ${seeded}`);
    api = await startServer(join("api", "index.js"), storeDir, env);
    web = await startServer("web-server.js", storeDir, env, `${origin}/index.html`);

    // كل صفحة ترد 200، ومعها سياسة أمان المحتوى.
    for (const page of ["index", "product", "cart", "checkout", "account", "orders", "track", "reset", "pay", "courier", "admin"]) {
      const res = await fetch(`${origin}/${page}.html`);
      if (res.status !== 200) throw new Error(`${page}.html -> ${res.status}`);
      if (!(res.headers.get("content-security-policy") ?? "").includes("script-src 'self'")) {
        throw new Error(`${page}.html is missing its Content-Security-Policy`);
      }
    }
    const js = await fetch(`${origin}/js/pages/checkout.js`);
    if (!(js.headers.get("content-type") ?? "").includes("javascript")) throw new Error("scripts served with the wrong type");
    // محاولة الخروج من مجلد web إلى ملف الأسرار: يجب ألا تصل.
    const secretProbe = await (await fetch(`${origin}/../.env`)).text();
    if (secretProbe.includes("OWNER_API_KEY")) throw new Error("the website server leaked .env");

    // صورة كل منتج يجب أن يقدمها الموقع فعلاً.
    const products = await (await fetch(`${api.base}/products?limit=100`)).json();
    for (const p of products) {
      const img = await fetch(`${origin}${p.imageUrl}`);
      if (img.status !== 200 || !(img.headers.get("content-type") ?? "").startsWith("image/")) {
        throw new Error(`photo of ${p.slug} is missing: ${p.imageUrl} -> ${img.status}`);
      }
    }

    const options = await (await fetch(`${api.base}/checkout/options`)).json();
    const cityRate = options.shippingMethods.find((m) => m.id === "city-rate");
    if (!cityRate?.cities?.includes("تاجوراء")) throw new Error("city-based delivery (with Tajoura) is not configured");

    // طلب CORS التمهيدي الذي يرسله المتصفح قبل "أضف إلى السلة" (كان خطأً حقيقياً مرة).
    const preflight = await fetch(`${api.base}/carts/00000000-0000-0000-0000-000000000000/items`, {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
    });
    if (preflight.status !== 204 || preflight.headers.get("access-control-allow-origin") !== origin) {
      throw new Error(`CORS preflight failed: ${preflight.status} ${preflight.headers.get("access-control-allow-origin")}`);
    }

    // node --check يفحص صياغة كل سكربت في الموقع دون تشغيله.
    const scripts = ["config", "store", "api", "ui", "icons", "order-view"]
      .map((f) => join(storeDir, "web", "js", `${f}.js`))
      .concat(["home", "product", "cart", "checkout", "account", "orders", "track", "reset", "pay"].map((f) => join(storeDir, "web", "js", "pages", `${f}.js`)))
      .concat(["common", "courier", "admin", "admin-orders", "admin-catalog"].map((f) => join(storeDir, "web", "js", "staff", `${f}.js`)));
    for (const file of scripts) run(process.execPath, ["--check", file], storeDir);

    return `${products.length} products with photos, 11 pages with CSP (shop, courier, admin), ${cityRate.cities.length} delivery cities, CORS preflight OK, ${scripts.length} scripts valid`;
  } finally {
    await stopServer(api);
    await stopServer(web);
  }
}

// التشغيل: الخطوات 0 إلى 4، ثم خطوة المتجر إن نجح البناء، ثم الملخص دائماً.
main()
  .then(() => (results.some((r) => r.name === "build (TypeScript)" && r.ok) ? step("Maa Store: API + website (shop, courier, admin)", storefrontStep) : undefined))
  .catch((err) => {
    results.push({ name: "verify script", ok: false });
    console.error(err);
  })
  .finally(async () => {
    // نترك قاعدة الاختبار فارغة ونظيفة للتشغيل التالي.
    if (TEST_DB) await resetTestDatabase().catch(() => undefined);
    const failed = results.filter((r) => !r.ok);
    console.log("\n" + "=".repeat(60));
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
    console.log("=".repeat(60));
    console.log(failed.length === 0 ? "ALL CHECKS PASSED" : `${failed.length} CHECK(S) FAILED`);
    // رمز الخروج 1 عند أي فشل، فتعرف أدوات أخرى (مثل CI لاحقاً) أن الفحص فشل.
    process.exitCode = failed.length === 0 ? 0 : 1;
  });
