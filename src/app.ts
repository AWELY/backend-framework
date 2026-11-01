import type { Server } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Pool } from "pg";
import { Router } from "./engine/router";
import { createServer } from "./engine/http/server";
import { Logger } from "./engine/logger";
import { AccessControl } from "./engine/access-control";
import { ServiceUnavailableError, UnauthorizedError } from "./engine/errors";
import { MetricsRegistry } from "./engine/metrics";
import { generateOpenApi } from "./engine/openapi";
import { validate, type FieldIssue } from "./engine/validation";
import { safeEqual } from "./engine/webhook";
import type { AppConfig } from "./engine/config";
import { Container } from "./container/container";
import { cors } from "./middleware/cors";
import { securityHeaders } from "./middleware/security-headers";
import { requestLogger } from "./middleware/request-logger";
import { httpMetrics } from "./middleware/metrics";
import { auditTrail } from "./middleware/audit";
import { idempotency } from "./middleware/idempotency";
import { createAuthenticator, requirePermission } from "./middleware/auth";
import { withInput } from "./middleware/validate";
import { PAGINATION_QUERY, sendPage } from "./modules/shared";
import { createPool, pingDatabase, type DatabaseOptions } from "./db/connection";
import { runMigrations, pendingMigrations, type Migration } from "./db/migrations";
import { coreModules, collectMigrations } from "./modules";
import type { CommerceModule, CommercePlugin, ModuleContext, RateLimiters } from "./modules/types";
import { ExtensionRegistry, type CommerceEvents } from "./modules/extensions";
import { FailureLimiter, type Limiter, type LimiterOptions } from "./engine/rate-limiter";
import { clientIp } from "./engine/http/client-ip";
import { runtimeMigrations } from "./runtime/migrations";
import { PostgresLimiter } from "./runtime/rate-limit";
import { SessionManager } from "./runtime/sessions";
import { PostgresIdempotencyStore } from "./runtime/idempotency";
import { AuditLog } from "./runtime/audit-log";
import { EventOutbox } from "./runtime/outbox";
import { JobQueue } from "./runtime/jobs";
import { BackgroundWorker } from "./runtime/worker";

/** إعداد حد محاولات واحد: العدد والنافذة، أو false لإطفائه. */
export type RateLimitSetting = Pick<LimiterOptions, "maxFailures" | "windowSeconds"> | false;

/** الخيارات التي يمررها المتجر إلى createCommerceApp. الإلزامي منها ثلاثة فقط. */
export interface CommerceAppOptions {
  /** رابط قاعدة البيانات (إلزامي). */
  databaseUrl: string;
  /** مفتاح المالك (إلزامي). */
  ownerApiKey: string;
  /** مفاتيح مالك قديمة تُقبل أثناء تغيير المفتاح. */
  previousOwnerApiKeys?: readonly string[];
  /** سر توقيع توكنات الدخول (إلزامي). */
  authTokenSecret: string;
  /** أسرار قديمة تُقبل أثناء تغيير السر، فلا يخرج الجميع لحظة التغيير. */
  previousAuthTokenSecrets?: readonly string[];
  /** كم تبقى صلاحية توكن الدخول بالثواني. الافتراضي 7 أيام. */
  tokenTtlSeconds?: number;
  /** المواقع المسموح لها باستدعاء الـ API من المتصفح. الافتراضي "*". */
  corsOrigin?: string | readonly string[];
  logger?: Logger;
  /** الوحدات المستخدمة. الافتراضي كل الوحدات المدمجة (coreModules). */
  modules?: CommerceModule[];
  /** الإضافات، وتُهيَّأ بعد كل الوحدات. مثال: [cashOnDelivery(), flatRateShipping({ rate: 10000 })] */
  plugins?: CommercePlugin[];
  /** جدول صلاحيات خاص بالمتجر. الافتراضي DEFAULT_ROLES. */
  accessControl?: AccessControl;
  /**
   * حد محاولات الدخول الفاشلة، لكل عنوان IP ولكل بريد. الافتراضي 10 كل 15 دقيقة.
   * القيمة false تطفئه (غير موصى بها إلا في الاختبارات وقياس الأداء).
   */
  loginRateLimit?: RateLimitSetting;
  /** حد إنشاء الحسابات لكل عنوان IP. الافتراضي 5 في الساعة. */
  registrationRateLimit?: RateLimitSetting;
  /** حد طلبات استعادة كلمة المرور لكل IP ولكل بريد. الافتراضي 5 في الساعة. */
  passwordResetRateLimit?: RateLimitSetting;
  /**
   * حد الطلبات (الشراء) لكل IP. مطفأ افتراضياً: خلف proxy دون trustProxy، كل الزبائن يظهرون بعنوان
   * واحد، فيصبح الحد على المتجر كله. فعّله بعد ضبط trustProxy، مثلاً { maxFailures: 30, windowSeconds: 600 }.
   */
  checkoutRateLimit?: RateLimitSetting;
  /** حد إنشاء السلال لكل IP. مطفأ افتراضياً لنفس السبب. */
  cartCreationRateLimit?: RateLimitSetting;
  /**
   * أين تُحفظ عدّادات حد المحاولات: "postgres" (الافتراضي، تعمل عبر عدة نسخ من الخادم) أو
   * "memory" (نسخة واحدة فقط، تُصفَّر عند إعادة التشغيل).
   */
  rateLimitStore?: "postgres" | "memory";
  /** قراءة عنوان العميل من X-Forwarded-For. فقط خلف Reverse proxy واحد موثوق. */
  trustProxy?: boolean;
  /** بادئة نسخة الـ API، مثل "/v1". مسارات النظام (/health، /metrics...) تبقى من الجذر. */
  basePath?: string;
  /** أقصى حجم لجسم الطلب بالبايت. الافتراضي 1 ميغابايت. */
  bodyLimitBytes?: number;
  /** عملة المتجر (ISO 4217). الافتراضي "LYD". */
  currency?: string;
  /** إعدادات مجموعة اتصالات القاعدة (الحجم، والمهلات). */
  database?: DatabaseOptions;
  /** العامل في الخلفية (الأحداث والمهام). false يطفئه (مثلاً في سكربت migrate). */
  workers?: { pollIntervalMs?: number } | false;
  /** GET /metrics. token يجعله يتطلب Authorization: Bearer <token>. false يطفئه. */
  metrics?: { token?: string } | false;
  /** GET /openapi.json. الافتراضي true. */
  openapi?: boolean;
  /** ترويسة Strict-Transport-Security (فعّلها فقط خلف HTTPS). */
  hsts?: boolean;
  /** مهلات خادم HTTP بالملي ثانية. */
  serverTimeouts?: { requestTimeoutMs?: number; headersTimeoutMs?: number; keepAliveTimeoutMs?: number };
  /** كم ينتظر close() الطلبات الجارية قبل قطعها. الافتراضي 10 ثوانٍ. */
  shutdownTimeoutMs?: number;
}

/** ما يحصل عليه المتجر: التطبيق جاهزاً، مع أدوات تشغيله. */
export interface CommerceApp {
  /** خادم HTTP من Node (لم يبدأ الاستماع بعد). */
  server: Server;
  /** متاح ليضيف المتجر مسارات خاصة به. */
  router: Router;
  /** مسارات النظام (/health و /livez و /readyz و /metrics و /openapi.json). */
  systemRouter: Router;
  container: Container;
  pool: Pool;
  logger: Logger;
  extensions: ExtensionRegistry;
  metrics: MetricsRegistry;
  jobs: JobQueue;
  sessions: SessionManager;
  /** كل migrations: وقت التشغيل، والوحدات، والإضافات. */
  migrations: Migration[];
  /** يطبّق migrations التي لم تُطبَّق بعد، ويرجع أرقامها. */
  migrate(): Promise<string[]>;
  /** أرقام migrations التي لم تُطبَّق بعد (لا يغيّر شيئاً). */
  pendingMigrations(): Promise<string[]>;
  /** يبدأ الاستماع على المنفذ (بعد onStart للوحدات والإضافات، ثم يشغّل العامل في الخلفية). */
  listen(port: number): Promise<void>;
  /**
   * إيقاف لطيف: /readyz يرد 503، ولا طلبات جديدة، وانتظار الجارية حتى timeoutMs، ثم إيقاف
   * العامل في الخلفية، و onStop للإضافات والوحدات بالترتيب العكسي، ثم إغلاق القاعدة.
   */
  close(options?: { timeoutMs?: number }): Promise<void>;
  /** ينفّذ كل الأحداث والمهام الجاهزة الآن (للاختبارات والسكربتات). */
  drainBackgroundWork(): Promise<void>;
  /** وصف OpenAPI 3.1 للـ API. */
  openapi(): Record<string, unknown>;
}

/** يبني حد محاولات حسب الإعداد ومكان الحفظ، أو null إن كان مطفأ. */
function buildLimiter(
  setting: RateLimitSetting | undefined,
  fallback: RateLimitSetting,
  store: "postgres" | "memory",
  pool: Pool,
  prefix: string
): Limiter | null {
  const resolved = setting === undefined ? fallback : setting;
  if (resolved === false) return null;
  return store === "memory" ? new FailureLimiter(resolved) : new PostgresLimiter(pool, { ...resolved, prefix });
}

/**
 * يتحقق من الإضافات عند الإقلاع: أسماء فريدة، والاعتماديات مثبتة قبلها، والإعدادات صحيحة.
 * أي مشكلة توقف الإقلاع برسالة واضحة، بدل أن تظهر عند أول طلب يستخدم الإضافة.
 */
function checkPlugins(modules: CommerceModule[], plugins: CommercePlugin[]): void {
  const installed = new Set(modules.map((m) => m.name));
  for (const plugin of plugins) {
    if (installed.has(plugin.name)) throw new Error(`Plugin name '${plugin.name}' is already used by a module or another plugin`);
    for (const dependency of plugin.dependsOn ?? []) {
      if (!installed.has(dependency)) {
        throw new Error(`Plugin '${plugin.name}' depends on '${dependency}', which must be installed before it`);
      }
    }
    if (plugin.configSchema) {
      try {
        validate(plugin.configSchema, plugin.config ?? {});
      } catch (err) {
        const issues = ((err as { details?: FieldIssue[] }).details ?? []).map((i) => `${i.field} ${i.message}`).join("; ");
        throw new Error(`Plugin '${plugin.name}' has an invalid config: ${issues || (err as Error).message}`);
      }
    }
    installed.add(plugin.name);
  }
}

/**
 * الاستدعاء الوحيد الذي يحتاجه مشروع المتجر: يبني مجموعة الاتصالات، وحاوية الـ DI، والـ Router،
 * والمصادقة والجلسات، وصندوق الصادر والمهام، وكل الوحدات والإضافات، ويرجع خادماً جاهزاً للاستماع.
 * هذا ما يجعل "API متجر كامل في أسطر قليلة" حقيقياً في المشاريع التي تنشئها أداة CLI.
 *
 * اسمها في التصميم: نقطة التجميع (Composition root). المكان الوحيد الذي تُركَّب فيه
 * كل قطع الإطار معاً، وكل قطعة أخرى تستلم ما تحتاجه من هنا ولا تنشئه بنفسها.
 */
export function createCommerceApp(options: CommerceAppOptions): CommerceApp {
  // 1. الأدوات الأساسية، بقيم افتراضية لما لم يُمرَّر.
  const logger = options.logger ?? new Logger("info");
  const modules = options.modules ?? coreModules;
  const plugins = options.plugins ?? [];
  checkPlugins(modules, plugins);
  const currency = options.currency ?? "LYD";
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`currency must be a 3-letter ISO 4217 code, got "${currency}"`);

  // 2. مجموعة الاتصالات الوحيدة بالقاعدة (لا تتصل الآن، بل عند أول استعلام).
  const pool = createPool(options.databaseUrl, { applicationName: "maa", ...options.database });
  // اتصال خامل انقطع (إعادة تشغيل القاعدة مثلاً) يطلق حدث error على المجموعة. بدون مستمع،
  // Node يعتبره خطأ غير ملتقط وينهي البرنامج كله. نسجله، والمجموعة تفتح اتصالاً جديداً عند الحاجة.
  pool.on("error", (err) => logger.error("Idle database connection failed", { message: err.message }));

  // 3. هياكل فارغة، تملؤها الوحدات والإضافات بعد قليل.
  const container = new Container();
  const router = new Router();
  const systemRouter = new Router();
  const accessControl = options.accessControl ?? new AccessControl();
  const extensions = new ExtensionRegistry(logger);
  const metrics = new MetricsRegistry();

  // 4. الجلسات والمصادقة: معالجان، required و optional، يتحققان من الجلسة مع كل طلب.
  const tokenTtl = options.tokenTtlSeconds ?? 7 * 24 * 60 * 60;
  const sessions = new SessionManager(pool, { secret: options.authTokenSecret, ttlSeconds: tokenTtl });
  const auth = createAuthenticator({
    ownerApiKey: options.ownerApiKey,
    previousOwnerApiKeys: options.previousOwnerApiKeys,
    tokenSecret: options.authTokenSecret,
    previousTokenSecrets: options.previousAuthTokenSecrets,
    sessions,
  });

  // 5. حدود المحاولات (في PostgreSQL افتراضياً، فتعمل عبر عدة نسخ من الخادم).
  const store = options.rateLimitStore ?? "postgres";
  const limiters: RateLimiters = {
    login: buildLimiter(options.loginRateLimit, { maxFailures: 10, windowSeconds: 15 * 60 }, store, pool, "login"),
    registration: buildLimiter(options.registrationRateLimit, { maxFailures: 5, windowSeconds: 60 * 60 }, store, pool, "register"),
    passwordReset: buildLimiter(options.passwordResetRateLimit, { maxFailures: 5, windowSeconds: 60 * 60 }, store, pool, "reset"),
    checkout: buildLimiter(options.checkoutRateLimit, false, store, pool, "checkout"),
    cartCreation: buildLimiter(options.cartCreationRateLimit, false, store, pool, "carts"),
  };
  const trustProxy = options.trustProxy ?? false;
  const ipOf = (req: Parameters<typeof clientIp>[0]) => clientIp(req, trustProxy);

  // 6. صندوق الصادر، وطابور المهام، والعامل الذي يشغّلهما في الخلفية.
  const outbox = new EventOutbox<CommerceEvents>(pool, extensions, logger, metrics);
  const jobs = new JobQueue(pool, logger, metrics);
  const workersEnabled = options.workers !== false;
  const worker = new BackgroundWorker(
    outbox,
    jobs,
    logger,
    options.workers === false ? undefined : options.workers?.pollIntervalMs
  );
  const events: ModuleContext["events"] = {
    publish: (db, event, payload, publishOptions) => outbox.publish(db, event, payload, publishOptions),
    notify: () => worker.nudge(),
  };

  // 7. التنظيف الدوري لجداول وقت التشغيل: كل ساعة، على نسخة واحدة فقط (المهام الدورية لا تتكرر).
  jobs.define("system.cleanup", async (_payload, { logger: jobLogger }) => {
    const statements = [
      "DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'",
      "DELETE FROM rate_limits WHERE reset_at < now()",
      "DELETE FROM auth_sessions WHERE expires_at < now() - interval '1 day' OR revoked_at < now() - interval '30 days'",
      "DELETE FROM outbox_events WHERE processed_at < now() - interval '7 days' OR dead_at < now() - interval '30 days'",
      "DELETE FROM jobs WHERE done_at < now() - interval '7 days' OR dead_at < now() - interval '30 days'",
    ];
    for (const sql of statements) await pool.query(sql);
    const { rows } = await pool.query<{ exists: boolean }>("SELECT to_regclass('password_resets') IS NOT NULL AS exists");
    if (rows[0]?.exists) await pool.query("DELETE FROM password_resets WHERE expires_at < now() - interval '1 day'");
    jobLogger.debug("Runtime tables cleaned");
  });
  jobs.schedule("system.cleanup", 60 * 60 * 1000);

  // 8. صندوق الأدوات الذي تستلمه كل وحدة وكل إضافة.
  const audit = new AuditLog(pool);
  const context: ModuleContext = {
    router,
    container,
    pool,
    accessControl,
    logger,
    authenticate: auth.required,
    authenticateOptional: auth.optional,
    // الوحدات تستطيع إصدار توكن، لكنها لا ترى السر: SessionManager يتذكره داخلياً.
    issueCustomerToken: async (customerId, req) =>
      (
        await sessions.issue(
          { type: "customer", id: customerId, role: "customer" },
          req ? { ip: ipOf(req), userAgent: req.headers["user-agent"] } : {}
        )
      ).token,
    extensions,
    loginLimiter: limiters.login,
    registrationLimiter: limiters.registration,
    limiters,
    clientIp: ipOf,
    events,
    jobs,
    sessions,
    audit,
    idempotency: idempotency(new PostgresIdempotencyStore(pool)),
    metrics,
    currency,
  };

  // 9. مسارات النظام، من جذر الخادم مهما كان basePath.
  let shuttingDown = false;
  const migrations: Migration[] = [];

  /** /health: الخادم يعمل والقاعدة ترد (كما كان دائماً). */
  systemRouter.get("/health", async (_req, res) => {
    try {
      await pingDatabase(pool);
    } catch {
      throw new ServiceUnavailableError("The database is unreachable");
    }
    res.json({ status: "ok", database: "ok" });
  });
  /** /livez: هل العملية حية؟ لا يلمس القاعدة (عطل القاعدة لا يعني أن إعادة تشغيل الخادم ستفيد). */
  systemRouter.get("/livez", (_req, res) => {
    res.json({ status: "ok" });
  });
  /**
   * /readyz: هل نستقبل طلبات الآن؟ 503 أثناء الإيقاف (فيتوقف موازن الأحمال عن الإرسال قبل أن
   * نغلق)، أو إن كانت القاعدة لا ترد، أو إن بقيت migrations لم تُطبَّق (كود أحدث من القاعدة).
   */
  systemRouter.get("/readyz", async (_req, res) => {
    if (shuttingDown) {
      res.status(503).json({ status: "shutting_down" });
      return;
    }
    try {
      const pending = await pendingMigrations(pool, migrations);
      if (pending.length > 0) {
        res.status(503).json({ status: "migrations_pending", pending });
        return;
      }
    } catch {
      res.status(503).json({ status: "database_unreachable" });
      return;
    }
    res.json({ status: "ready" });
  });
  if (options.metrics !== false) {
    const token = options.metrics?.token;
    systemRouter.get("/metrics", (req, res) => {
      if (token && !safeEqual(req.headers.authorization ?? "", `Bearer ${token}`)) {
        throw new UnauthorizedError("A metrics token is required");
      }
      res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      res.send(metrics.render());
    });
  }
  if (options.openapi !== false) {
    systemRouter.get("/openapi.json", (_req, res) => {
      res.json(app.openapi());
    });
  }

  // مقاييس عامة: اتصالات القاعدة، والذاكرة، وتأخر حلقة الأحداث (Event loop lag: هل الخادم مشغول بحساب يمنعه من الرد؟).
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  metrics.gauge("db_pool_connections", "Database pool connections by state", () => [
    { labels: { state: "total" }, value: pool.totalCount },
    { labels: { state: "idle" }, value: pool.idleCount },
    { labels: { state: "waiting" }, value: pool.waitingCount },
  ]);
  metrics.gauge("process_resident_memory_bytes", "Resident memory size in bytes", () => process.memoryUsage().rss);
  metrics.gauge("process_uptime_seconds", "Process uptime in seconds", () => Math.round(process.uptime()));
  metrics.gauge("nodejs_eventloop_lag_p99_seconds", "Event loop delay, 99th percentile, in seconds", () => {
    const p99 = loopDelay.percentile(99) / 1e9;
    loopDelay.reset();
    return Number.isFinite(p99) ? p99 : 0;
  });

  /** سجل التدقيق: من فعل ماذا ومتى (audit:read). ?actorId= &action= (بداية العملية، مثل "PATCH /products"). */
  router.get(
    "/audit-log",
    auth.required,
    requirePermission(accessControl, "audit:read"),
    withInput(
      {
        query: {
          actorId: { type: "string", maxLength: 100, optional: true },
          action: { type: "string", maxLength: 200, optional: true },
          ...PAGINATION_QUERY,
        },
        summary: "Read the audit log",
      },
      async (_req, res, { query }) => {
        sendPage(res, await audit.list({ actorId: query.actorId, action: query.action, limit: query.limit ?? 50, offset: query.offset ?? 0 }));
      }
    )
  );

  // 10. الوحدات، بترتيب الاعتماد (modules/index.ts)، ثم الإضافات لتستطيع استخدام أي خدمة منها.
  for (const module of modules) module.register(context);
  for (const plugin of plugins) plugin.setup(context);

  // 11. كل migrations في قائمة واحدة. لا تُنفَّذ الآن، بل عند migrate().
  migrations.push(...runtimeMigrations, ...collectMigrations(modules), ...plugins.flatMap((p) => p.migrations ?? []));

  // 12. خادم HTTP، مع المعالجات العامة التي تعمل على كل طلب قبل أي شيء، بهذا الترتيب.
  const shutdownGuard: Parameters<typeof createServer>[0]["globalMiddleware"][number] = (_req, res, next) => {
    // أثناء الإيقاف: نطلب من العميل إغلاق الاتصال بعد هذا الرد، فلا يرسل عليه طلباً جديداً.
    if (shuttingDown) res.setHeader("Connection", "close");
    next();
  };
  const server = createServer({
    router,
    systemRouter,
    basePath: options.basePath ?? "",
    bodyLimitBytes: options.bodyLimitBytes,
    globalMiddleware: [
      cors(options.corsOrigin ?? "*"),
      securityHeaders({ hsts: options.hsts }),
      shutdownGuard,
      ...(options.metrics !== false ? [httpMetrics(metrics)] : []),
      requestLogger(logger),
      auditTrail(audit, { clientIp: ipOf }),
    ],
    logger,
  });
  server.requestTimeout = options.serverTimeouts?.requestTimeoutMs ?? 30_000;
  server.headersTimeout = options.serverTimeouts?.headersTimeoutMs ?? 15_000;
  server.keepAliveTimeout = options.serverTimeouts?.keepAliveTimeoutMs ?? 5_000;

  let started: Promise<void> | undefined;
  let closing: Promise<void> | undefined;

  const app: CommerceApp = {
    server,
    router,
    systemRouter,
    container,
    pool,
    logger,
    extensions,
    metrics,
    jobs,
    sessions,
    migrations,
    migrate: () => runMigrations(pool, migrations, (m) => logger.info(m)),
    pendingMigrations: () => pendingMigrations(pool, migrations),
    // المنفذ المشغول يجعل الوعد يُرفض برسالة واضحة، بدل أن ينهار البرنامج بخطأ 'error'
    // غير ملتقط (الخطأ رقم 3 في جدول 6.5).
    listen: async (port) => {
      started ??= (async () => {
        for (const module of modules) await module.onStart?.(context);
        for (const plugin of plugins) await plugin.onStart?.(context);
      })();
      await started;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, () => {
          server.off("error", reject);
          resolve();
        });
      });
      loopDelay.enable();
      if (workersEnabled) worker.start();
    },
    close: (closeOptions = {}) => {
      closing ??= (async () => {
        shuttingDown = true;
        const timeoutMs = closeOptions.timeoutMs ?? options.shutdownTimeoutMs ?? 10_000;
        // لا طلبات جديدة، والاتصالات الخاملة (keep-alive) تُغلق الآن، والجارية تُنتظر حتى المهلة.
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeIdleConnections();
        const force = setTimeout(() => server.closeAllConnections(), timeoutMs);
        force.unref();
        await closed;
        clearTimeout(force);
        loopDelay.disable();
        await worker.stop();
        for (const plugin of [...plugins].reverse()) {
          await Promise.resolve(plugin.onStop?.(context)).catch((err: unknown) =>
            logger.error(`Plugin '${plugin.name}' failed to stop`, { message: err instanceof Error ? err.message : String(err) })
          );
        }
        for (const module of [...modules].reverse()) await module.onStop?.(context);
        await pool.end();
      })();
      return closing;
    },
    drainBackgroundWork: () => worker.drain(),
    openapi: () =>
      generateOpenApi(router.list(), systemRouter.list(), {
        title: "Maa commerce API",
        version: "1.0.0",
        description: "Generated from the route schemas. Error codes: see components.schemas.Error.",
        basePath: options.basePath ?? "",
      }),
  };
  return app;
}

/**
 * يحوّل الإعدادات المقروءة من البيئة (loadConfig) إلى خيارات createCommerceApp، فلا يكرر كل متجر
 * نفس الأسطر. الخيارات الخاصة بالمتجر (plugins، accessControl...) تُضاف فوقها:
 *   createCommerceApp({ ...optionsFromConfig(config, logger), plugins: [...] })
 */
export function optionsFromConfig(config: AppConfig, logger?: Logger): CommerceAppOptions {
  return {
    databaseUrl: config.databaseUrl,
    ownerApiKey: config.ownerApiKey,
    previousOwnerApiKeys: config.previousOwnerApiKeys,
    authTokenSecret: config.authTokenSecret,
    previousAuthTokenSecrets: config.previousAuthTokenSecrets,
    corsOrigin: config.corsOrigin,
    trustProxy: config.trustProxy,
    basePath: config.basePath,
    bodyLimitBytes: config.bodyLimitBytes,
    currency: config.currency,
    database: config.database,
    metrics: config.metricsToken ? { token: config.metricsToken } : {},
    hsts: config.hsts,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    logger: logger ?? new Logger(config.logLevel, { format: config.logFormat }),
  };
}
