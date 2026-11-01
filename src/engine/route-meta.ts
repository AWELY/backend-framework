import type { InputSpec } from "./validation";

/**
 * "بطاقة تعريف" المسار: معلومات وصفية تلصقها المعالجات بنفسها، ويجمعها الـ Router عند التسجيل.
 *
 * لماذا؟ ثلاثة أجزاء تحتاج أن تعرف عن المسار أكثر من طريقته ومساره:
 *   - مولّد OpenAPI (engine/openapi.ts): ما شكل الجسم والاستعلام؟ هل يحتاج دخولاً؟ أي صلاحية؟
 *   - سجل التدقيق والمقاييس: اسم المسار المسجّل ("/products/:id") بدل الرابط الحقيقي.
 *   - التوثيق: ملخص من سطر واحد لكل مسار.
 *
 * بدل أن نطلب من كل وحدة أن تكتب هذه المعلومات مرتين (مرة في الكود ومرة في التوثيق)، كل معالج
 * يحمل ما يعرفه عن نفسه: authenticate يقول "أنا مصادقة إلزامية"، و requirePermission يقول
 * "أنا أطلب الصلاحية products:write"، و withInput يحمل الـ schema. الـ Router يدمجها.
 */
export interface RouteMeta {
  /** "required": يرفض المجهول بـ 401. "optional": يقبل المجهول ويتعرف على المعروف. */
  auth?: "required" | "optional";
  /** الصلاحية المطلوبة، مثل "products:write". */
  permission?: string;
  /** شكل المدخلات (من withInput في middleware/validate.ts). */
  input?: InputSpec;
  /** وصف المسار في سطر واحد، يظهر في OpenAPI. */
  summary?: string;
  /** رمز الحالة عند النجاح، مثل 201 للإنشاء. الافتراضي 200. */
  successStatus?: number;
  /** المسار يقبل ترويسة Idempotency-Key (middleware/idempotency.ts). */
  idempotent?: boolean;
  /** المسار يقبل If-Match (التعديل المتفائل، Optimistic concurrency). */
  conditional?: boolean;
}

// رمز (Symbol) وليس اسم خاصية عادياً: لا يتعارض مع أي خاصية أخرى على الدالة، ولا يظهر في JSON.
const META = Symbol("routeMeta");

type WithMeta = { [META]?: RouteMeta };

/** يلصق معلومات وصفية بمعالج ويرجعه نفسه (ليس نسخة)، فيبقى استخدامه كما هو. */
export function withMeta<H extends object>(handler: H, meta: RouteMeta): H {
  const target = handler as H & WithMeta;
  target[META] = { ...target[META], ...meta };
  return handler;
}

/** يجمع معلومات كل معالجات المسار في بطاقة واحدة. المعالج اللاحق يكمل ما قبله. */
export function readMeta(handlers: readonly object[]): RouteMeta {
  const merged: RouteMeta = {};
  for (const handler of handlers) Object.assign(merged, (handler as WithMeta)[META]);
  return merged;
}
