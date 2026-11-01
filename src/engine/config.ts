/**
 * يقرأ الإعدادات من متغيرات البيئة (process.env)، أي من ملف .env بعد أن يحمّله dotenv.
 *
 * هذا هو المكان الوحيد في الإطار الذي يقرأ process.env مباشرة. كل الأجزاء الأخرى
 * تستلم الإعدادات كقيم عادية (مثل createCommerceApp({ databaseUrl, ... }))، وهذا يجعل
 * اختبارها سهلاً دون متغيرات بيئة حقيقية.
 *
 * لماذا الإعدادات في .env وليست في الكود؟
 *   - الأسرار (كلمة سر القاعدة، ومفتاح المالك) لا يجب أن تُرفع إلى GitHub، و .env مستثنى في .gitignore.
 *   - كل جهاز له قيمه (جهازك، وجهاز زميلك، والخادم لاحقاً) بنفس الكود.
 */

/** مستويات السجل من الأكثر تفصيلاً إلى الأهم. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** كل إعدادات التطبيق بعد قراءتها والتحقق منها. */
export interface AppConfig {
  /** بيئة التشغيل، مثل "development" أو "production". */
  env: string;
  /** المنفذ الذي يستمع عليه الخادم، والافتراضي 3000. */
  port: number;
  /** مفتاح المالك: يُرسل في ترويسة X-Api-Key ليعطي صلاحيات المالك كاملة. */
  ownerApiKey: string;
  /** السر الذي توقَّع به توكنات دخول الزبائن. تغييره يُخرج كل الزبائن من حساباتهم. */
  authTokenSecret: string;
  logLevel: LogLevel;
  /** الموقع المسموح له باستدعاء الـ API من المتصفح، مثل "http://localhost:5173". */
  corsOrigin: string;
  /** رابط الاتصال بـ PostgreSQL، مثل postgresql://user:password@localhost:5432/ama_store */
  databaseUrl: string;
  /** true فقط إن كان التطبيق خلف Reverse proxy واحد موثوق، مثل nginx (انظر http/client-ip.ts). */
  trustProxy: boolean;
}

/** يقرأ متغيراً إلزامياً. إن لم يوجد، يفشل الإقلاع فوراً برسالة واضحة بدل أن ينهار الخادم لاحقاً. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

/**
 * يقرأ سراً، ويرفض السر الضعيف: يجب أن يكون 32 حرفاً على الأقل، وألا يكون القيمة المثالية
 * من .env.example (التي تبدأ بـ "change-me").
 * السبب: لو نسي أحد تغيير المفتاح، لعمل المتجر بمفتاح يعرفه الجميع. هنا لا يقلع البرنامج أصلاً.
 * رسالة الخطأ تعطي أمراً جاهزاً لتوليد سر عشوائي.
 */
function secret(name: string): string {
  const value = required(name);
  if (value.startsWith("change-me") || value.length < 32) {
    throw new Error(
      `${name} must be a random value of at least 32 characters. Generate one with:\n` +
        `  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
    );
  }
  return value;
}

/**
 * يقرأ كل الإعدادات ويتحقق منها. يستدعيها المتجر عند الإقلاع (storefront/api/app.js و src/dev-server.ts).
 * "??" تعني: إن لم توجد القيمة، استخدم القيمة الافتراضية بعدها.
 */
export function loadConfig(): AppConfig {
  return {
    env: process.env.NODE_ENV ?? "development",
    port: Number(process.env.PORT ?? 3000),
    ownerApiKey: secret("OWNER_API_KEY"),
    authTokenSecret: secret("AUTH_TOKEN_SECRET"),
    logLevel: (process.env.LOG_LEVEL as LogLevel) ?? "info",
    // "*" تسمح لأي موقع. متجر AMA يضبطها على عنوان موقعه فقط.
    corsOrigin: process.env.CORS_ORIGIN ?? "*",
    databaseUrl: required("DATABASE_URL"),
    // true فقط إن كُتبت حرفياً "true". أي قيمة أخرى تعني false، وهذا هو الأكثر أماناً.
    trustProxy: process.env.TRUST_PROXY === "true",
  };
}
