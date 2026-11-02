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
 *
 * الفحص عند الإقلاع (Fail fast): كل قيمة تُفحص، وكل المشاكل تُجمع في رسالة واحدة. هكذا لا يكتشف
 * المطوّر مشكلة، فيصلحها، ثم يعيد التشغيل ليكتشف الثانية. وقيمة خاطئة مثل PORT=abc أو
 * LOG_LEVEL=verbose توقف الإقلاع برسالة واضحة، بدل أن يعمل الخادم بسلوك غريب.
 * القائمة الكاملة للمتغيرات وقيمها الافتراضية في .env.example وفي README.
 */

/** مستويات السجل من الأكثر تفصيلاً إلى الأهم. */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** كل إعدادات التطبيق بعد قراءتها والتحقق منها. */
export interface AppConfig {
  /** بيئة التشغيل، مثل "development" أو "production". */
  env: string;
  /** المنفذ الذي يستمع عليه الخادم، والافتراضي 3000. */
  port: number;
  /** مفتاح المالك: يُرسل في ترويسة X-Api-Key ليعطي صلاحيات المالك كاملة. */
  ownerApiKey: string;
  /** مفاتيح مالك قديمة ما زالت تُقبل أثناء تغيير المفتاح (OWNER_API_KEY_PREVIOUS، مفصولة بفواصل). */
  previousOwnerApiKeys: string[];
  /** السر الذي توقَّع به توكنات الدخول. تغييره دون PREVIOUS يُخرج الجميع من حساباتهم. */
  authTokenSecret: string;
  /** أسرار توقيع قديمة ما زالت تُقبل أثناء التغيير (AUTH_TOKEN_SECRET_PREVIOUS). */
  previousAuthTokenSecrets: string[];
  logLevel: LogLevel;
  /** "pretty" للطرفية (الافتراضي في التطوير)، "json" لأدوات جمع السجلات (الافتراضي في الإنتاج). */
  logFormat: "pretty" | "json";
  /** المواقع المسموح لها باستدعاء الـ API من المتصفح: "*" أو موقع أو عدة مواقع مفصولة بفواصل. */
  corsOrigin: string;
  /** رابط الاتصال بـ PostgreSQL، مثل postgresql://user:password@localhost:5432/maa_store */
  databaseUrl: string;
  /** true فقط إن كان التطبيق خلف Reverse proxy واحد موثوق، مثل nginx (انظر http/client-ip.ts). */
  trustProxy: boolean;
  /** بادئة نسخة الـ API، مثل "/v1". الافتراضي "" (بلا بادئة). */
  basePath: string;
  /** أقصى حجم لجسم الطلب بالبايت. */
  bodyLimitBytes: number;
  /** عملة المتجر بصيغة ISO 4217، مثل "LYD". كل المبالغ بأصغر وحدة فيها. */
  currency: string;
  /** إعدادات مجموعة اتصالات القاعدة. */
  database: {
    poolMax: number;
    statementTimeoutMs: number;
    idleInTransactionTimeoutMs: number;
    connectionTimeoutMs: number;
  };
  /** إن وُضع: GET /metrics يتطلب Authorization: Bearer <هذه القيمة>. */
  metricsToken?: string;
  /** كم ننتظر الطلبات الجارية عند الإيقاف قبل قطعها. */
  shutdownTimeoutMs: number;
  /** كم ننتظر بعد أن يصبح /readyz 503 وقبل رفض الاتصالات (ليتوقف موازن الأحمال عن الإرسال أولاً). */
  shutdownDelayMs: number;
  /** ترويسة Strict-Transport-Security (فعّلها فقط خلف HTTPS). */
  hsts: boolean;
}

/** يقرأ كل الإعدادات من env (الافتراضي process.env) ويتحقق منها. يرمي خطأ واحداً بكل المشاكل. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const problems: string[] = [];

  /** يقرأ متغيراً إلزامياً. */
  const required = (name: string): string => {
    const value = env[name];
    if (!value) {
      problems.push(`${name} is required (copy .env.example to .env and fill it in)`);
      return "";
    }
    return value;
  };

  /**
   * يقرأ سراً، ويرفض السر الضعيف: يجب أن يكون 32 حرفاً على الأقل، وألا يكون القيمة المثالية
   * من .env.example (التي تبدأ بـ "change-me").
   * السبب: لو نسي أحد تغيير المفتاح، لعمل المتجر بمفتاح يعرفه الجميع. هنا لا يقلع البرنامج أصلاً.
   */
  const checkSecret = (name: string, value: string): void => {
    if (value && (value.startsWith("change-me") || value.length < 32)) {
      problems.push(
        `${name} must be a random value of at least 32 characters. Generate one with:\n` +
          `    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
      );
    }
  };
  const secret = (name: string): string => {
    const value = required(name);
    checkSecret(name, value);
    return value;
  };
  const secretList = (name: string): string[] => {
    const values = (env[name] ?? "").split(",").map((v) => v.trim()).filter(Boolean);
    for (const v of values) checkSecret(name, v);
    return values;
  };

  /** رقم صحيح بين حدين، أو القيمة الافتراضية إن لم يُضبط. */
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
      return fallback;
    }
    return value;
  };

  /** true أو false فقط. "yes" أو "1" خطأ صريح، حتى لا يظن أحد أنه فعّل خياراً وهو لم يفعّله. */
  const flag = (name: string, fallback: boolean): boolean => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    if (raw === "true") return true;
    if (raw === "false") return false;
    problems.push(`${name} must be "true" or "false", got "${raw}"`);
    return fallback;
  };

  const nodeEnv = env.NODE_ENV ?? "development";

  const logLevel = (env.LOG_LEVEL ?? "info") as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}, got "${logLevel}"`);

  const logFormat = env.LOG_FORMAT ?? (nodeEnv === "production" ? "json" : "pretty");
  if (logFormat !== "pretty" && logFormat !== "json") problems.push(`LOG_FORMAT must be "pretty" or "json", got "${logFormat}"`);

  const corsOrigin = env.CORS_ORIGIN ?? "*";
  for (const origin of corsOrigin.split(",").map((o) => o.trim())) {
    if (origin !== "*" && !/^https?:\/\/[^/\s]+$/.test(origin)) {
      problems.push(`CORS_ORIGIN entries must be "*" or an origin like https://shop.example (no path), got "${origin}"`);
    }
  }

  const basePath = env.API_BASE_PATH ?? "";
  if (basePath && !/^(\/[a-z0-9-]+)+$/.test(basePath)) {
    problems.push(`API_BASE_PATH must look like "/v1" (lowercase, no trailing slash), got "${basePath}"`);
  }

  const currency = env.CURRENCY ?? "LYD";
  if (!/^[A-Z]{3}$/.test(currency)) problems.push(`CURRENCY must be a 3-letter ISO 4217 code like LYD, got "${currency}"`);

  const databaseUrl = required("DATABASE_URL");
  if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push("DATABASE_URL must start with postgresql:// or postgres://");
  }

  const config: AppConfig = {
    env: nodeEnv,
    port: integer("PORT", 3000, 0, 65535),
    ownerApiKey: secret("OWNER_API_KEY"),
    previousOwnerApiKeys: secretList("OWNER_API_KEY_PREVIOUS"),
    authTokenSecret: secret("AUTH_TOKEN_SECRET"),
    previousAuthTokenSecrets: secretList("AUTH_TOKEN_SECRET_PREVIOUS"),
    logLevel,
    logFormat: logFormat as AppConfig["logFormat"],
    corsOrigin,
    databaseUrl,
    trustProxy: flag("TRUST_PROXY", false),
    basePath,
    bodyLimitBytes: integer("BODY_LIMIT_BYTES", 1024 * 1024, 1024, 100 * 1024 * 1024),
    currency,
    database: {
      poolMax: integer("DB_POOL_MAX", 10, 1, 1000),
      statementTimeoutMs: integer("DB_STATEMENT_TIMEOUT_MS", 15_000, 0, 3_600_000),
      idleInTransactionTimeoutMs: integer("DB_IDLE_IN_TRANSACTION_TIMEOUT_MS", 30_000, 0, 3_600_000),
      connectionTimeoutMs: integer("DB_CONNECTION_TIMEOUT_MS", 5_000, 0, 600_000),
    },
    shutdownTimeoutMs: integer("SHUTDOWN_TIMEOUT_MS", 10_000, 0, 600_000),
    shutdownDelayMs: integer("SHUTDOWN_DELAY_MS", 0, 0, 120_000),
    hsts: flag("HSTS", false),
  };
  if (env.METRICS_TOKEN) config.metricsToken = env.METRICS_TOKEN;

  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
  }
  return config;
}
