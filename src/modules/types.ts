import type { Pool } from "pg";
import type { Router, Handler } from "../engine/router";
import type { Container } from "../container/container";
import type { AccessControl } from "../engine/access-control";
import type { Logger } from "../engine/logger";
import type { Migration } from "../db/migrations";
import type { ExtensionRegistry } from "./extensions";
import type { FailureLimiter } from "../engine/rate-limiter";
import type { AppRequest } from "../engine/http/request";

/**
 * "صندوق الأدوات" الذي تستلمه كل وحدة وكل إضافة عند تسجيلها.
 *
 * الوحدات لا تُنشئ أي شيء من هذه بنفسها: createCommerceApp (src/app.ts) ينشئها مرة واحدة
 * ويعطيها للجميع. فائدة ذلك أن كل الوحدات تشترك في نفس الـ Router، ونفس الحاوية، ونفس
 * مجموعة اتصالات القاعدة، وأن الاختبار يستطيع تمرير صندوق أدوات مختلف.
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
   * يصدر توكن دخول موقّعاً لزبون. الوحدات تستطيع إصدار التوكن، لكنها لا ترى سر التوقيع
   * نفسه: الدالة "تتذكر" السر داخلياً (Closure)، وهذا تطبيق لمبدأ أقل صلاحية ممكنة.
   */
  issueCustomerToken(customerId: string): string;
  /** طرق الشحن والدفع ومستمعو الأحداث التي تضيفها الإضافات (extensions.ts). */
  extensions: ExtensionRegistry;
  /** عدّاد محاولات الدخول الفاشلة لكل عنوان ولكل بريد، أو null إن أُطفئ حد المحاولات. */
  loginLimiter: FailureLimiter | null;
  /** عدّاد محاولات التسجيل لكل عنوان، أو null إن أُطفئ. */
  registrationLimiter: FailureLimiter | null;
  /** عنوان IP للمرسل. يأخذ X-Forwarded-For في الاعتبار فقط إن كان trustProxy مفعّلاً. */
  clientIp(req: AppRequest): string;
}

/**
 * العقد الذي تلتزم به كل وحدة تجارية (الأقسام، والمنتجات، والمخزون، والزبائن، والسلة، والطلبات):
 *   - name: اسمها.
 *   - migrations: سكربتات SQL لجداولها.
 *   - register: تسجّل مستودعاتها في حاوية الـ DI، ومساراتها في الـ Router.
 *
 * أي شيء يلتزم بهذا الشكل يمكن تركيبه في الإطار، وهذا ما يجعل الإطار "معيارياً" (Modular).
 */
export interface CommerceModule {
  name: string;
  migrations: Migration[];
  register(context: ModuleContext): void;
}

/**
 * الإضافة (Plugin): تُهيَّأ بعد كل الوحدات، لتستطيع استخدام أي خدمة منها (مثل طلب
 * ORDERS_SERVICE من الحاوية)، وتسجيل طرق شحن ودفع، ومستمعي أحداث، ومسارات إضافية.
 *
 * الفرق عن الوحدة: الوحدة جزء أساسي من الإطار، والإضافة يختارها كل متجر حسب حاجته
 * (مثلاً AMA يختار الشحن حسب المدينة والدفع عند الاستلام)، دون تعديل كود الإطار.
 *
 * أرقام migrations الإضافات يجب أن تبدأ من "9000_"، فتُطبَّق دائماً بعد جداول الإطار.
 */
export interface CommercePlugin {
  name: string;
  migrations?: Migration[];
  setup(context: ModuleContext): void;
}
