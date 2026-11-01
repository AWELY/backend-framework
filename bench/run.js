"use strict";

/**
 * قياس أداء الإطار للتقرير (الفصل 6). بلا مكتبة قياس: مولّد حمل HTTP صغير بـ node:http
 * (باتصالات تبقى مفتوحة، keep-alive) ضد الإطار وهو يعمل في عملية منفصلة (bench/server.js)،
 * على قاعدة PostgreSQL حقيقية.
 *
 *   npm run build && npm run bench
 *
 * يستخدم TEST_DATABASE_URL (تُمسح ثم تُملأ ببيانات القياس). النتائج تُطبع بصيغة JSON.
 *
 * ما يقيسه:
 *   - الأداء: طلبات في الثانية، وزمن الاستجابة p50 و p95 و p99 لخمسة سيناريوهات.
 *   - زمن الإقلاع حتى أول رد يلمس القاعدة.
 *   - الذاكرة: عند الخمول، وبعد الحمل.
 *   - تكلفة التحقق من كلمة مرور واحدة (scrypt).
 *   - حجم الحزمة وعدد الاعتماديات (الأرقام التي يذكرها التقرير عن "خفة الوزن").
 */

require("dotenv").config({ quiet: true });
const http = require("node:http");
const { fork, execSync } = require("node:child_process");
const { join } = require("node:path");
const os = require("node:os");
const { createCommerceApp, Logger, PRODUCTS_REPOSITORY, INVENTORY_REPOSITORY, hashPassword, verifyPassword } = require("../dist/index");

// منفذ الخادم المقاس، وعدد العملاء المتزامنين (50)، ومدة كل سيناريو (10 ثوانٍ)، وزمن الإحماء (ثانيتان).
const PORT = 3999;
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 50);
const DURATION_MS = Number(process.env.BENCH_DURATION_MS ?? 10_000);
const WARMUP_MS = 2_000;
const DB_URL = process.env.TEST_DATABASE_URL;

// حماية: القاعدة ستُمسح، فيجب أن يحتوي اسمها كلمة test.
if (!DB_URL || !/test/i.test(new URL(DB_URL).pathname)) {
  throw new Error("TEST_DATABASE_URL must be set and its database name must contain 'test' (it is wiped).");
}

/** يمسح القاعدة، ويطبّق الجداول، وينشئ productCount منتجاً بمخزون كبير، ويرجع أرقامها. */
async function prepareDatabase(productCount) {
  const app = createCommerceApp({
    databaseUrl: DB_URL,
    ownerApiKey: "x".repeat(32),
    authTokenSecret: "y".repeat(32),
    logger: new Logger("error"),
  });
  await app.pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await app.migrate();
  const products = app.container.resolve(PRODUCTS_REPOSITORY);
  const inventory = app.container.resolve(INVENTORY_REPOSITORY);
  const ids = [];
  for (let i = 0; i < productCount; i++) {
    const p = await products.create({ name: `Bench product ${i}`, slug: `bench-${i}`, price: 1000 + i });
    await inventory.set(p.id, 1_000_000);
    ids.push(p.id);
  }
  await app.pool.end();
  return ids;
}

/**
 * يشغّل bench/server.js كعملية منفصلة (fork تفتح قناة اتصال بين العمليتين، IPC)، ويقيس
 * زمن الإقلاع: من لحظة التشغيل حتى أول رد على /health، الذي يلمس القاعدة فعلاً.
 * --expose-gc: يسمح للخادم بتشغيل جمع القمامة يدوياً قبل قياس الذاكرة.
 */
function startServer() {
  const started = process.hrtime.bigint();
  const child = fork(join(__dirname, "server.js"), [], {
    env: { ...process.env, PORT: String(PORT), BENCH_DATABASE_URL: DB_URL },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    execArgv: ["--expose-gc"],
  });
  return new Promise((resolve, reject) => {
    child.once("message", async (msg) => {
      if (msg !== "ready") return;
      // "جاهز" تعني: يستمع، ويرد على طلب حقيقي يلمس القاعدة.
      await request({ method: "GET", path: "/health" });
      resolve({ child, startupMs: Number(process.hrtime.bigint() - started) / 1e6 });
    });
    child.once("exit", (code) => reject(new Error(`server exited early with code ${code}`)));
  });
}

// وكيل اتصالات يعيد استخدام الاتصالات المفتوحة (keep-alive)، كما يفعل أي عميل حقيقي،
// فنقيس الإطار لا كلفة فتح اتصال جديد مع كل طلب.
const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY });

/** يرسل طلباً واحداً، ويرجع رمز الحالة والجسم. */
function request({ method, path, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        method,
        path,
        agent,
        headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * النسبة المئوية (Percentile) من قائمة أزمنة مرتبة.
 * p50 (الوسيط): نصف الطلبات أسرع منه. p99: 99% من الطلبات أسرع منه، أي أنه يُظهر أبطأ 1%.
 * لماذا لا نكتفي بالمتوسط؟ المتوسط يخفي الطلبات البطيئة القليلة، أما p99 فيُظهرها.
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/**
 * سيناريو حمل واحد: CONCURRENCY عاملاً، كل عامل يرسل طلبات متتالية بلا توقف لمدة DURATION_MS.
 * قبلها إحماء لثانيتين لا يُسجَّل (حتى تسخن الذاكرة المؤقتة وتُفتح الاتصالات).
 * أي رد برمز غير المتوقع يُعدّ خطأ.
 */
async function load(name, makeRequest, expectedStatus) {
  const runFor = async (ms, record) => {
    const until = Date.now() + ms;
    const latencies = [];
    let errors = 0;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (Date.now() < until) {
          const t0 = process.hrtime.bigint();
          try {
            const res = await request(makeRequest());
            if (res.status !== expectedStatus) errors++;
          } catch {
            errors++;
          }
          // الزمن بالنانو ثانية، ونحوّله إلى ملي ثانية.
          if (record) latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
        }
      })
    );
    return { latencies, errors };
  };

  await runFor(WARMUP_MS, false);
  const { latencies, errors } = await runFor(DURATION_MS, true);
  latencies.sort((a, b) => a - b);
  const round = (n) => Math.round(n * 100) / 100;
  return {
    scenario: name,
    requests: latencies.length,
    requestsPerSecond: Math.round(latencies.length / (DURATION_MS / 1000)),
    latencyMs: {
      p50: round(percentile(latencies, 50)),
      p95: round(percentile(latencies, 95)),
      p99: round(percentile(latencies, 99)),
      max: round(latencies[latencies.length - 1] ?? 0),
    },
    errors,
  };
}

/** تكلفة التحقق من كلمة مرور واحدة: ما تدفعه كل محاولة دخول غير محظورة (متوسط 20 مرة). */
async function scryptCost() {
  const hash = await hashPassword("benchmark-password");
  const runs = 20;
  const started = process.hrtime.bigint();
  for (let i = 0; i < runs; i++) await verifyPassword("benchmark-password", hash);
  return Math.round(Number(process.hrtime.bigint() - started) / 1e6 / runs);
}

/**
 * حجم الإطار كحزمة npm، وعدد اعتمادياته:
 *   - npm pack --dry-run: حجم الحزمة مضغوطة وغير مضغوطة، وعدد ملفاتها، دون إنشائها فعلاً.
 *   - npm ls --omit=dev: كل حزم وقت التشغيل المثبتة (المباشرة واعتمادياتها).
 */
function footprint() {
  const root = join(__dirname, "..");
  const pack = JSON.parse(execSync("npm pack --dry-run --json", { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString())[0];
  const prodTree = execSync("npm ls --omit=dev --all --parseable", { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim()
    .split("\n")
    .slice(1); // السطر الأول هو المشروع نفسه
  const direct = Object.keys(require("../package.json").dependencies ?? {});
  return {
    packageSizeKB: Math.round(pack.size / 102.4) / 10,
    unpackedSizeKB: Math.round(pack.unpackedSize / 102.4) / 10,
    packagedFiles: pack.entryCount,
    directRuntimeDependencies: direct,
    totalRuntimePackagesInstalled: prodTree.length,
  };
}

async function main() {
  // وصف الجهاز الذي جرى عليه القياس، ليُذكر مع النتائج.
  const environment = {
    node: process.version,
    os: `${os.type()} ${os.release()}`,
    cpu: os.cpus()[0]?.model.trim(),
    logicalCores: os.cpus().length,
    totalMemoryGB: Math.round(os.totalmem() / 1024 ** 3),
    concurrency: CONCURRENCY,
    durationSeconds: DURATION_MS / 1000,
  };

  const ids = await prepareDatabase(50);
  const { child, startupMs } = await startServer();
  const memory = async () => JSON.parse((await request({ method: "GET", path: "/bench/memory" })).body);

  try {
    const idle = await memory();
    const results = [];
    // من الأخف إلى الأثقل: فحص الحالة، ثم قراءة قائمة، ثم قراءة صف واحد، ثم كتابة.
    results.push(await load("GET /health (framework + DB ping)", () => ({ method: "GET", path: "/health" }), 200));
    results.push(await load("GET /products?limit=20 (DB read, list)", () => ({ method: "GET", path: "/products?limit=20" }), 200));
    let i = 0;
    results.push(
      await load("GET /products/:id (DB read, one row)", () => ({ method: "GET", path: `/products/${ids[i++ % ids.length]}` }), 200)
    );
    results.push(await load("POST /carts (DB write)", () => ({ method: "POST", path: "/carts" }), 201));
    // سيل محاولات دخول من عنوان واحد: بعد 10 محاولات فاشلة، يرد حد المحاولات بـ 429 دون حساب
    // hash كلمة المرور، فلا يعود الهجوم يشغل الخادم.
    results.push(
      await load(
        "POST /customers/login flood (rate limited -> 429)",
        () => ({ method: "POST", path: "/customers/login", body: { email: "nobody@bench.ly", password: "wrong-password" } }),
        429
      )
    );
    const afterLoad = await memory();

    console.log(
      JSON.stringify(
        {
          environment,
          scryptVerifyMs: await scryptCost(),
          footprint: footprint(),
          startupMs: Math.round(startupMs),
          // مقاسة بعد جمع القمامة كاملاً بالقوة (انظر bench/server.js).
          memoryMB: {
            idleRss: Math.round(idle.rss / 1024 ** 2),
            idleHeapUsed: Math.round(idle.heapUsed / 1024 ** 2),
            afterLoadRss: Math.round(afterLoad.rss / 1024 ** 2),
            afterLoadHeapUsed: Math.round(afterLoad.heapUsed / 1024 ** 2),
          },
          results,
        },
        null,
        2
      )
    );
  } finally {
    child.kill();
    agent.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
