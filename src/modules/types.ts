import type { Pool } from "pg";
import type { Router, Handler } from "../engine/router";
import type { Container } from "../container/container";
import type { AccessControl } from "../engine/access-control";
import type { Logger } from "../engine/logger";
import type { Migration } from "../db/migrations";
import type { Queryable } from "../db/repository";
import type { Schema } from "../engine/validation";
import type { MetricsRegistry } from "../engine/metrics";
import type { Limiter } from "../engine/rate-limiter";
import type { AppRequest } from "../engine/http/request";
import type { JobQueue } from "../runtime/jobs";
import type { SessionManager } from "../runtime/sessions";
import type { AuditLog } from "../runtime/audit-log";
import type { CommerceEvents, ExtensionRegistry } from "./extensions";

/**
 * يكتب الأحداث في صندوق الصادر (src/runtime/outbox.ts).
 *   publish: داخل معاملة التغيير نفسها (db = اتصال المعاملة)، فيُحفظ الحدث معها أو لا يُحفظ.
 *   notify : بعد COMMIT، ليوصل العامل الحدث فوراً بدل انتظار دورته القادمة (تحسين، ليس شرطاً).
 */
export interface EventPublisher {
  publish<E extends keyof CommerceEvents>(
    db: Queryable,
    event: E,
    payload: CommerceEvents[E],
    options?: { sensitive?: boolean }
  ): Promise<string>;
  notify(): void;
}

/** حدود المحاولات المتاحة للوحدات. null تعني أن الحد مطفأ. */
export interface RateLimiters {
  login: Limiter | null;
  registration: Limiter | null;
  passwordReset: Limiter | null;
  checkout: Limiter | null;
  cartCreation: Limiter | null;
}

/**
 * "صندوق الأدوات" الذي تستلمه كل وحدة وكل إضافة عند الإقلاع. يبنيه createCommerceApp (src/app.ts).
 * الوحدات لا تنشئ شيئاً من هذه بنفسها: كل شيء يأتيها من هنا (حقن الاعتماديات)، فيمكن
 * استبدال أي جزء في الاختبار أو في متجر خاص.
 */
export interface ModuleContext {
  /** لتسجيل مسارات الوحدة. */
  router: Router;
  /** لتسجيل خدمات الوحدة، وطلب خدمات الوحدات الأخرى. */
  container: Container;
  /** مجموعة الاتصالات الوحيدة بقاعدة البيانات. */
  pool: Pool;
  /** جدول الأدوار والصلاحيات، تمرره الوحدة إلى requirePermission. */
  accessControl: AccessControl;
  logger: Logger;
  /** يرفض الطلب بـ 401 إن لم يكن المرسل معروفاً (auth.required). */
  authenticate: Handler;
  /** يتعرف على المرسل إن أرسل بيانات دخول، ويسمح للمجهول بالمرور (auth.optional). */
  authenticateOptional: Handler;
  /**
   * ينشئ جلسة دخول لزبون ويرجع توكنها. الوحدات تستطيع إصدار توكن، لكنها لا ترى السر.
   * أصبحت async لأن الجلسة تُحفظ في القاعدة. للتحكم الكامل استخدم sessions.issue.
   */
  issueCustomerToken(customerId: string, req?: AppRequest): Promise<string>;
  /** طرق الشحن والدفع ومعدّلات السعر ومستمعو الأحداث التي تضيفها الإضافات (extensions.ts). */
  extensions: ExtensionRegistry;
  /** عدّاد محاولات الدخول الفاشلة لكل عنوان ولكل بريد، أو null إن أُطفئ حد المحاولات. */
  loginLimiter: Limiter | null;
  /** عدّاد محاولات التسجيل لكل عنوان، أو null إن أُطفئ. */
  registrationLimiter: Limiter | null;
  /** كل حدود المحاولات. */
  limiters: RateLimiters;
  /** عنوان IP للمرسل. يأخذ X-Forwarded-For في الاعتبار فقط إن كان trustProxy مفعّلاً. */
  clientIp(req: AppRequest): string;
  /** لكتابة الأحداث في صندوق الصادر. */
  events: EventPublisher;
  /** طابور المهام في الخلفية: define و enqueue و schedule. */
  jobs: JobQueue;
  /** جلسات الدخول: إصدار، وإلغاء، وقائمة. */
  sessions: SessionManager;
  /** سجل التدقيق، لأحداث أمنية لا تمر بمسار كتابة عادي (مثل دخول موظف). */
  audit: AuditLog;
  /** معالج Idempotency-Key جاهز، يوضع في مسار بعد المصادقة (middleware/idempotency.ts). */
  idempotency: Handler;
  /** سجل المقاييس، لتضيف الوحدة أو الإضافة مقاييسها. */
  metrics: MetricsRegistry;
  /** عملة المتجر، مثل "LYD". */
  currency: string;
}

/**
 * وحدة تجارية: جداولها (migrations)، وما تسجله عند الإقلاع (register).
 * onStart و onStop اختياريتان: تعملان قبل بدء الاستماع وعند الإيقاف.
 */
export interface CommerceModule {
  name: string;
  migrations: Migration[];
  register(context: ModuleContext): void;
  onStart?(context: ModuleContext): void | Promise<void>;
  onStop?(context: ModuleContext): void | Promise<void>;
}

/**
 * إضافة (Plugin): مثل الوحدة، لكنها اختيارية وتُهيَّأ بعد كل الوحدات، فتستطيع استخدام أي خدمة منها.
 *
 *   name         : اسم فريد. اسمان متطابقان خطأ عند الإقلاع.
 *   version      : نسخة الإضافة (للسجل والتشخيص).
 *   dependsOn    : أسماء وحدات أو إضافات يجب أن تُثبَّت قبلها، وإلا يفشل الإقلاع برسالة واضحة.
 *   configSchema : شكل إعدادات الإضافة؛ config يُفحص به عند الإقلاع (لا عند أول استخدام).
 *   migrations   : جداول الإضافة.
 *   setup        : التسجيل (طرق شحن ودفع، ومسارات، ومستمعون، ومهام).
 *   onStart/onStop: قبل بدء الاستماع، وعند الإيقاف (بالترتيب العكسي).
 */
export interface CommercePlugin {
  name: string;
  version?: string;
  dependsOn?: string[];
  configSchema?: Schema;
  config?: Record<string, unknown>;
  migrations?: Migration[];
  setup(context: ModuleContext): void;
  onStart?(context: ModuleContext): void | Promise<void>;
  onStop?(context: ModuleContext): void | Promise<void>;
}
