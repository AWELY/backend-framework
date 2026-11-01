import type { Server } from "node:http";
import type { Pool } from "pg";
import { Router } from "./engine/router";
import { createServer } from "./engine/http/server";
import { Logger } from "./engine/logger";
import { AccessControl } from "./engine/access-control";
import { Container } from "./container/container";
import { cors } from "./middleware/cors";
import { requestLogger } from "./middleware/request-logger";
import { createAuthenticator } from "./middleware/auth";
import { signToken } from "./engine/auth-token";
import { createPool, pingDatabase } from "./db/connection";
import { runMigrations } from "./db/migrations";
import { coreModules, collectMigrations } from "./modules";
import type { CommerceModule, CommercePlugin, ModuleContext } from "./modules/types";
import { ExtensionRegistry } from "./modules/extensions";
import { FailureLimiter, type LimiterOptions } from "./engine/rate-limiter";
import { clientIp } from "./engine/http/client-ip";

/** الخيارات التي يمررها المتجر إلى createCommerceApp. الإلزامي منها ثلاثة فقط. */
export interface CommerceAppOptions {
  /** رابط قاعدة البيانات (إلزامي). */
  databaseUrl: string;
  /** مفتاح المالك (إلزامي). */
  ownerApiKey: string;
  /** سر توقيع توكنات دخول الزبائن (إلزامي). */
  authTokenSecret: string;
  /** كم تبقى صلاحية توكن الدخول بالثواني. الافتراضي 7 أيام. */
  tokenTtlSeconds?: number;
  /** الموقع المسموح له باستدعاء الـ API من المتصفح. الافتراضي "*". */
  corsOrigin?: string;
  logger?: Logger;
  /** الوحدات المستخدمة. الافتراضي كل الوحدات الست المدمجة. */
  modules?: CommerceModule[];
  /** الإضافات، وتُهيَّأ بعد كل الوحدات. مثال: [cashOnDelivery(), flatRateShipping({ rate: 10000 })] */
  plugins?: CommercePlugin[];
  /** جدول صلاحيات خاص بالمتجر. الافتراضي DEFAULT_ROLES. */
  accessControl?: AccessControl;
  /**
   * حد محاولات الدخول الفاشلة، لكل عنوان IP ولكل بريد. الافتراضي 10 كل 15 دقيقة.
   * القيمة false تطفئه (غير موصى بها إلا في الاختبارات وقياس الأداء).
   */
  loginRateLimit?: Pick<LimiterOptions, "maxFailures" | "windowSeconds"> | false;
  /**
   * حد إنشاء الحسابات لكل عنوان IP (كل محاولة تصل إلى حساب hash كلمة المرور).
   * الافتراضي 5 في الساعة. القيمة false تطفئه.
   */
  registrationRateLimit?: Pick<LimiterOptions, "maxFailures" | "windowSeconds"> | false;
  /** قراءة عنوان العميل من X-Forwarded-For. فقط خلف Reverse proxy واحد موثوق. */
  trustProxy?: boolean;
}

/** ما يحصل عليه المتجر: التطبيق جاهزاً، مع أدوات تشغيله. */
export interface CommerceApp {
  /** خادم HTTP من Node (لم يبدأ الاستماع بعد). */
  server: Server;
  /** متاح ليضيف المتجر مسارات خاصة به. */
  router: Router;
  container: Container;
  pool: Pool;
  logger: Logger;
  extensions: ExtensionRegistry;
  /** يطبّق migrations الوحدات والإضافات التي لم تُطبَّق بعد، ويرجع أرقامها. */
  migrate(): Promise<string[]>;
  /** يبدأ الاستماع على المنفذ. */
  listen(port: number): Promise<void>;
  /** يغلق الخادم (بعد انتهاء الطلبات الجارية)، ثم اتصالات القاعدة. */
  close(): Promise<void>;
}

/**
 * الاستدعاء الوحيد الذي يحتاجه مشروع المتجر: يبني مجموعة الاتصالات، وحاوية الـ DI،
 * والـ Router، والمصادقة، وكل الوحدات والإضافات، ويرجع خادماً جاهزاً للاستماع.
 * هذا ما يجعل "API متجر كامل في أسطر قليلة" حقيقياً في المشاريع التي تنشئها أداة CLI.
 *
 * اسمها في التصميم: نقطة التجميع (Composition root). المكان الوحيد الذي تُركَّب فيه
 * كل قطع الإطار معاً، وكل قطعة أخرى تستلم ما تحتاجه من هنا ولا تنشئه بنفسها.
 *
 * تستخدمها خمسة أماكن بإعدادات مختلفة: خادم التطوير (dev-server.ts)، ومتجر AMA،
 * والمتجر التجريبي، وقالب أداة CLI، والاختبارات.
 */
export function createCommerceApp(options: CommerceAppOptions): CommerceApp {
  // 1. الأدوات الأساسية، بقيم افتراضية لما لم يُمرَّر.
  const logger = options.logger ?? new Logger("info");
  const modules = options.modules ?? coreModules;
  const plugins = options.plugins ?? [];

  // 2. مجموعة الاتصالات الوحيدة بالقاعدة (لا تتصل الآن، بل عند أول استعلام).
  const pool = createPool(options.databaseUrl);

  // 3. هياكل فارغة، تملؤها الوحدات والإضافات بعد قليل.
  const container = new Container();
  const router = new Router();
  const accessControl = options.accessControl ?? new AccessControl();
  const extensions = new ExtensionRegistry(logger);

  // 4. المصادقة: معالجان، required و optional.
  const auth = createAuthenticator({ ownerApiKey: options.ownerApiKey, tokenSecret: options.authTokenSecret });
  // 7 أيام بالثواني: 7 × 24 ساعة × 60 دقيقة × 60 ثانية.
  const tokenTtl = options.tokenTtlSeconds ?? 7 * 24 * 60 * 60;

  // 5. عدّادا حد المحاولات (في الذاكرة)، أو null إن أطفأهما المتجر بـ false.
  const loginLimiter =
    options.loginRateLimit === false
      ? null
      : new FailureLimiter(options.loginRateLimit ?? { maxFailures: 10, windowSeconds: 15 * 60 });
  const registrationLimiter =
    options.registrationRateLimit === false
      ? null
      : new FailureLimiter(options.registrationRateLimit ?? { maxFailures: 5, windowSeconds: 60 * 60 });
  const trustProxy = options.trustProxy ?? false;

  // 6. صندوق الأدوات الذي تستلمه كل وحدة وكل إضافة.
  const context: ModuleContext = {
    router,
    container,
    pool,
    accessControl,
    logger,
    authenticate: auth.required,
    authenticateOptional: auth.optional,
    // الوحدات تستطيع إصدار توكن، لكنها لا ترى السر: الدالة تتذكره داخلياً (Closure).
    issueCustomerToken: (customerId) =>
      signToken({ sub: customerId, role: "customer" }, options.authTokenSecret, tokenTtl),
    extensions,
    loginLimiter,
    registrationLimiter,
    clientIp: (req) => clientIp(req, trustProxy),
  };

  // 7. فحص الحالة: الخادم يعمل، والقاعدة ترد. أول مسار يُسجَّل، وهو من الإطار نفسه.
  router.get("/health", async (_req, res) => {
    await pingDatabase(pool);
    res.json({ status: "ok", database: "ok" });
  });

  // 8. الوحدات، بترتيب الاعتماد (modules/index.ts): كل وحدة تسجّل خدماتها ومساراتها.
  for (const module of modules) module.register(context);
  // 9. الإضافات أخيراً، لتستطيع استخدام خدمات أي وحدة ومساراتها.
  for (const plugin of plugins) plugin.setup(context);

  // 10. نجمع migrations الوحدات والإضافات في قائمة واحدة. لا تُنفَّذ الآن، بل عند migrate().
  const migrations = [...collectMigrations(modules), ...plugins.flatMap((p) => p.migrations ?? [])];

  // 11. خادم HTTP، مع المعالجات العامة التي تعمل على كل طلب قبل أي شيء: cors ثم requestLogger.
  const server = createServer({
    router,
    globalMiddleware: [cors(options.corsOrigin ?? "*"), requestLogger(logger)],
    logger,
  });

  // 12. التطبيق جاهز، لكنه لا يستمع بعد. المتجر يقرر متى يستدعي listen.
  return {
    server,
    router,
    container,
    pool,
    logger,
    extensions,
    migrate: () => runMigrations(pool, migrations, (m) => logger.info(m)),
    // المنفذ المشغول يجعل الوعد يُرفض برسالة واضحة، بدل أن ينهار البرنامج بخطأ 'error'
    // غير ملتقط (الخطأ رقم 3 في جدول 6.5).
    // server.once: المستمع يعمل مرة واحدة. وبعد نجاح الاستماع نزيله بـ server.off، فمهمته انتهت.
    listen: (port) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, () => {
          server.off("error", reject);
          resolve();
        });
      }),
    // الإغلاق بالترتيب: الخادم أولاً (لا طلبات جديدة، وينتظر الجارية)، ثم اتصالات القاعدة.
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    },
  };
}
