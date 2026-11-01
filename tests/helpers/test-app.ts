// أدوات مشتركة لكل اختبارات التكامل (tests/integration): تشغيل التطبيق الحقيقي على قاعدة
// اختبار، وإرسال الطلبات إليه.
import { config as loadEnv } from "dotenv";
import type { AddressInfo } from "node:net";
import { createCommerceApp, Logger, type CommerceApp, type CommerceAppOptions } from "../../src/index";

// يقرأ .env، ومنه TEST_DATABASE_URL.
loadEnv({ quiet: true });

// مفتاح مالك وسر توكن ثابتان للاختبارات فقط، معروفان عمداً (الاختبار يحتاج أن يعرفهما).
export const OWNER_KEY = "test-owner-key";
export const TOKEN_SECRET = "test-token-secret-that-is-at-least-32-chars";

/** التطبيق قيد الاختبار، وعنوانه، ودالة إغلاقه. */
export interface TestApp {
  app: CommerceApp;
  /** مثل http://localhost:53124 */
  base: string;
  close(options?: { timeoutMs?: number }): Promise<void>;
}

/**
 * يشغّل خادماً حقيقياً على منفذ فارغ عشوائي، مع قاعدة PostgreSQL حقيقية تُمسح بالكامل
 * وتُعاد جداولها أولاً، فيبدأ كل ملف اختبار من قاعدة نظيفة.
 *
 * يرفض العمل إلا إذا احتوى اسم القاعدة كلمة "test"، فلا يمكن أن يمسح بيانات التطوير أو
 * بيانات المتجر بالخطأ (مثلاً لو وُضع رابط ama_store في TEST_DATABASE_URL سهواً).
 *
 * لماذا قاعدة حقيقية وليست محاكاة (Mock)؟ لنختبر ما تفعله القاعدة فعلاً: القيود (CHECK و
 * UNIQUE)، والمعاملات، والأقفال. المحاكاة لا تثبت أن الطلبين المتزامنين لا يبيعان آخر قطعة مرتين.
 *
 * options: ما يختلف بين الاختبارات، مثل الإضافات، أو إطفاء حد المحاولات.
 */
export async function startTestApp(options: Partial<CommerceAppOptions> & { resetDatabase?: boolean } = {}): Promise<TestApp> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (see .env.example)");
  // pathname في رابط القاعدة هو اسمها، مثل "/commerce_test".
  if (!/test/i.test(new URL(url).pathname)) {
    throw new Error("Refusing to run: TEST_DATABASE_URL must point to a database whose name contains 'test'");
  }

  const { resetDatabase = true, ...appOptions } = options;
  const app = createCommerceApp({
    databaseUrl: url,
    ownerApiKey: OWNER_KEY,
    authTokenSecret: TOKEN_SECRET,
    // سجل الأخطاء فقط، حتى لا تمتلئ نتائج الاختبار بسطر لكل طلب.
    logger: new Logger("error"),
    ...appOptions,
  });
  // نحذف كل الجداول (المخطط public كاملاً) وننشئه من جديد، ثم نطبّق الـ migrations.
  // resetDatabase: false لنسخة ثانية من التطبيق على نفس القاعدة (اختبار عدة نسخ).
  if (resetDatabase) await app.pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await app.migrate();
  // المنفذ 0 يعني "أي منفذ فارغ يختاره النظام"، فلا تتعارض الاختبارات مع خادم آخر.
  await app.listen(0);
  const { port } = app.server.address() as AddressInfo;
  return { app, base: `http://localhost:${port}`, close: (closeOptions) => app.close(closeOptions) };
}

/** الرد كما تراه الاختبارات: رمز الحالة، والجسم بعد قراءة JSON. */
export interface ApiResponse {
  status: number;
  body: any;
  headers: Headers;
}

/**
 * يرسل طلباً إلى التطبيق قيد الاختبار عبر HTTP حقيقي، كما يفعل أي عميل.
 *   owner: true   يضيف مفتاح المالك.
 *   token         يضيف توكن زبون.
 * مثال: await api(base, "POST", "/products", { owner: true, body: { ... } })
 */
export async function api(
  base: string,
  method: string,
  path: string,
  options: { body?: unknown; owner?: boolean; token?: string; headers?: Record<string, string>; raw?: string } = {}
): Promise<ApiResponse> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.owner) headers["x-api-key"] = OWNER_KEY;
  if (options.token) headers["authorization"] = `Bearer ${options.token}`;
  if (options.body !== undefined || options.raw !== undefined) headers["content-type"] ??= "application/json";
  const res = await fetch(base + path, {
    method,
    headers,
    body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, headers: res.headers };
}

/** ينشئ منتجاً بمخزون ويرجع رقمه. */
export async function createProduct(
  base: string,
  options: { price?: number; stock?: number; name?: string } = {}
): Promise<string> {
  const slug = `p-${Math.random().toString(36).slice(2, 10)}`;
  const p = await api(base, "POST", "/products", { owner: true, body: { name: options.name ?? slug, slug, price: options.price ?? 1000 } });
  if (p.status !== 201) throw new Error(`createProduct failed: ${JSON.stringify(p.body)}`);
  await api(base, "PUT", `/inventory/${p.body.id}`, { owner: true, body: { quantity: options.stock ?? 100 } });
  return p.body.id as string;
}

/** ينشئ سلة ضيف فيها سطور. */
export async function createCart(
  base: string,
  lines: Array<{ productId: string; variantId?: string; quantity: number }>,
  token?: string
): Promise<string> {
  const cart = await api(base, "POST", "/carts", { token });
  for (const line of lines) {
    const res = await api(base, "POST", `/carts/${cart.body.id}/items`, { body: line, token });
    if (res.status !== 200) throw new Error(`add to cart failed: ${JSON.stringify(res.body)}`);
  }
  return cart.body.id as string;
}

/** بيانات تواصل صالحة لإتمام الشراء. */
export const CONTACT = { contactName: "Test Buyer", contactPhone: "0912345678", shippingAddress: "Tripoli, Omar Mukhtar St." };

/** يسجّل زبوناً جديداً ويرجع { token, customer }. */
export async function registerCustomer(base: string, overrides: Record<string, unknown> = {}) {
  const email = `c-${Math.random().toString(36).slice(2, 10)}@example.ly`;
  const res = await api(base, "POST", "/customers/register", {
    body: { email, password: "correct-horse-battery", name: "Test Customer", ...overrides },
  });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  return { token: res.body.token as string, customer: res.body.customer, email, password: "correct-horse-battery", cartId: res.body.cartId };
}

/** ينشئ موظفاً بدور (بمفتاح المالك) ويسجل دخوله، ويرجع { token, staff }. */
export async function createStaff(base: string, role: string, overrides: Record<string, unknown> = {}) {
  const email = `s-${Math.random().toString(36).slice(2, 10)}@maa.ly`;
  const created = await api(base, "POST", "/staff", {
    owner: true,
    body: { email, password: "staff-password-123", name: `Staff ${role}`, role, phone: "0921112233", ...overrides },
  });
  if (created.status !== 201) throw new Error(`create staff failed: ${JSON.stringify(created.body)}`);
  const login = await api(base, "POST", "/staff/login", { body: { email, password: "staff-password-123" } });
  return { token: login.body.token as string, staff: created.body, email };
}
