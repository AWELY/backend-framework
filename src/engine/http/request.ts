import type { IncomingMessage } from "node:http";
import type { Logger } from "../logger";

/**
 * شكل الطلب كما يصل إلى أي معالج في الإطار (middleware أو handler).
 *
 * Node يعطينا الطلب الخام من نوع IncomingMessage، وأهم ما فيه:
 *   - method:  طريقة الطلب، مثل "GET" أو "POST".
 *   - url:     المسار مع الاستعلام، مثل "/products/1?color=red".
 *   - headers: الترويسات، وأسماؤها بحروف صغيرة دائماً، مثل headers["content-type"].
 *
 * و AppRequest هو نفس الطلب (extends) مضافاً إليه حقول، يملؤها الإطار
 * قبل أن يصل الطلب إلى أي handler.
 *
 * هذا الملف أنواع فقط: TypeScript يستخدمه للفحص ثم يحذفه عند الترجمة،
 * فلا يبقى منه أي كود وقت التشغيل (انظر dist/engine/http/request.js).
 */
export interface AppRequest extends IncomingMessage {
  /**
   * متغيرات المسار، ويملؤها الـ Router (router.ts).
   * مثال: المسار المسجّل "/products/:id" والطلب "/products/2" يعطيان { id: "2" }
   */
  params: Record<string, string>;
  /**
   * الاستعلام، أي ما بعد علامة "?" في الرابط، ويملؤه server.ts.
   * مثال: الطلب "/products?categoryId=5" فيكون req.query.get("categoryId") هو "5"
   * و URLSearchParams يفك الترميز تلقائياً، ويتعامل مع المفتاح المكرر.
   */
  query: URLSearchParams;
  /**
   * جسم الطلب بعد قراءته، ويملؤه readBody في server.ts:
   *   - إن كان JSON صحيحاً يصبح كائن JavaScript.
   *   - إن لم يكن JSON يبقى نصاً كما هو.
   *   - إن لم يوجد جسم يكون undefined.
   * نوعه unknown عمداً وليس any: TypeScript يمنع استخدامه قبل التأكد من شكله،
   * فنضطر لفحصه أولاً بـ validateBody (middleware/validate.ts).
   */
  body: unknown;
  /**
   * من أرسل الطلب، ويضعه middleware/auth.ts بعد التحقق من الهوية:
   *   - المالك (بمفتاح X-Api-Key) تكون قيمته { role: "owner" }
   *   - الزبون (بتوكن Bearer) تكون قيمته { role: "customer", userId: "..." }
   * علامة "?" تعني أنه اختياري: لا يوجد للضيف، ولا في المسارات التي لا تحتاج مصادقة.
   */
  auth?: {
    role: string;
    userId?: string;
    /** نوع المرسل: المالك (بالمفتاح)، أو زبون، أو موظف. */
    principal?: "owner" | "customer" | "staff";
    /** رقم جلسة الدخول (للزبون والموظف)، يستخدمه تسجيل الخروج لإلغاء هذه الجلسة وحدها. */
    sessionId?: string;
  };
  /**
   * رقم فريد لهذا الطلب، يضعه server.ts: من ترويسة X-Request-Id إن أرسلها العميل أو الـ proxy
   * بصيغة صحيحة، وإلا رقم جديد. يعود في ترويسة الرد، وفي جسم أي خطأ، وفي كل سطر سجل للطلب،
   * فيمكن تتبع شكوى زبون ("رقم الطلب في رسالة الخطأ هو ...") حتى سطر السجل نفسه.
   */
  id: string;
  /** سجل فرعي يضيف requestId إلى كل سطر (engine/logger.ts). */
  log: Logger;
  /**
   * الجسم كما وصل، بايتات خاماً قبل JSON.parse. تحتاجه إضافات الدفع للتحقق من توقيع الـ webhook:
   * التوقيع محسوب على البايتات الأصلية، وأي إعادة بناء للـ JSON (ترتيب مفاتيح، مسافات) تكسره.
   */
  rawBody?: Buffer;
  /** المسار المسجّل الذي طابق، مثل "/products/:id" (للسجل والمقاييس والتدقيق). */
  route?: string;
}
