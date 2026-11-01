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
  close(): Promise<void>;
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
export async function startTestApp(
  options: Pick<CommerceAppOptions, "plugins" | "loginRateLimit" | "registrationRateLimit" | "trustProxy"> = {}
): Promise<TestApp> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (see .env.example)");
  // pathname في رابط القاعدة هو اسمها، مثل "/commerce_test".
  if (!/test/i.test(new URL(url).pathname)) {
    throw new Error("Refusing to run: TEST_DATABASE_URL must point to a database whose name contains 'test'");
  }

  const app = createCommerceApp({
    databaseUrl: url,
    ownerApiKey: OWNER_KEY,
    authTokenSecret: TOKEN_SECRET,
    // سجل الأخطاء فقط، حتى لا تمتلئ نتائج الاختبار بسطر لكل طلب.
    logger: new Logger("error"),
    ...options,
  });
  // نحذف كل الجداول (المخطط public كاملاً) وننشئه من جديد، ثم نطبّق الـ migrations.
  await app.pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await app.migrate();
  // المنفذ 0 يعني "أي منفذ فارغ يختاره النظام"، فلا تتعارض الاختبارات مع خادم آخر.
  await app.listen(0);
  const { port } = app.server.address() as AddressInfo;
  return { app, base: `http://localhost:${port}`, close: () => app.close() };
}

/** الرد كما تراه الاختبارات: رمز الحالة، والجسم بعد قراءة JSON. */
export interface ApiResponse {
  status: number;
  body: any;
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
  options: { body?: unknown; owner?: boolean; token?: string; headers?: Record<string, string> } = {}
): Promise<ApiResponse> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.owner) headers["x-api-key"] = OWNER_KEY;
  if (options.token) headers["authorization"] = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(base + path, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
