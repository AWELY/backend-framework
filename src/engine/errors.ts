/**
 * أنواع الأخطاء المركزية في الإطار.
 *
 * أي خطأ يريد الإطار، أو متجر مبني عليه، أن يتحول إلى رد HTTP برمز محدد، يجب أن يرث
 * من AppError. كل صنف هنا يحمل رمز الحالة الخاص به:
 *
 *   ValidationError       400  طلب غير صالح (JSON معطوب، حقل ناقص أو غير معروف)
 *   UnauthorizedError     401  لا نعرف من أنت (لا توكن، أو توكن غير صالح)
 *   ForbiddenError        403  نعرفك، لكن ليست لديك الصلاحية
 *   NotFoundError         404  غير موجود
 *   ConflictError         409  تعارض مع الحالة الحالية (مخزون لا يكفي، بريد مسجل من قبل)
 *   TooManyRequestsError  429  محاولات كثيرة، ومعه ترويسة Retry-After
 *
 * و toErrorResponse هي المكان الوحيد الذي يقرر كيف يتحول أي خطأ إلى رد HTTP.
 * مكانها هنا في المحرك (engine) وليس في middleware/، لأن الخادم نفسه يحتاجها في حالات
 * لا يراها أي middleware: مسار غير موجود، أو جسم JSON معطوب (انظر engine/http/server.ts).
 */

/**
 * الأب لكل الأخطاء المعروفة. استخدامه في أي مكان:
 *   throw new NotFoundError("Product not found");
 * والخطأ يصل وحده إلى onError في server.ts، فيتحول إلى رد 404 بالشكل الموحد.
 */
export class AppError extends Error {
  /** رمز حالة HTTP، مثل 404. readonly: لا يتغير بعد إنشاء الخطأ. */
  readonly statusCode: number;
  /** تفاصيل إضافية تُرسل للعميل، مثل قائمة الحقول الخاطئة في ValidationError. */
  readonly details?: unknown;
  /** ترويسات إضافية للرد، مثل Retry-After مع 429. */
  headers?: Record<string, string>;

  constructor(message: string, statusCode = 500, details?: unknown) {
    super(message);
    // new.target هو الصنف الذي أُنشئ فعلاً (مثل NotFoundError وليس AppError)،
    // فيظهر اسمه الصحيح في السجل وفي الـ stack.
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.details = details;
    // يجعل الـ stack يبدأ من مكان رمي الخطأ، لا من داخل هذا الـ constructor.
    // و "?." لأن captureStackTrace موجودة في Node وليست في كل بيئات JavaScript.
    Error.captureStackTrace?.(this, new.target);
  }
}

/** 400: المدخلات غير صالحة. details تحمل كل المشاكل معاً، مثل [{ field, message }]. */
export class ValidationError extends AppError {
  constructor(message = "Validation failed", details?: unknown) {
    super(message, 400, details);
  }
}

/** 401: المصادقة مطلوبة أو فشلت (لا نعرف من أنت). */
export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, 401);
  }
}

/** 403: نعرف من أنت، لكن دورك لا يملك الصلاحية المطلوبة. */
export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(message, 403);
  }
}

/** 404: الشيء المطلوب غير موجود، أو لا يحق لك معرفة أنه موجود (مثل سلة غيرك). */
export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(message, 404);
  }
}

/** 409: الطلب صحيح، لكنه يتعارض مع الحالة الحالية، مثل مخزون لا يكفي أو سلة اشتُريت من قبل. */
export class ConflictError extends AppError {
  constructor(message = "Conflict", details?: unknown) {
    super(message, 409, details);
  }
}

/**
 * 429: محاولات كثيرة (حد المحاولات في الدخول والتسجيل).
 * يضع ترويسة Retry-After بعدد الثواني، فيعرف العميل متى يحاول من جديد،
 * ويضعها أيضاً في details لمن يقرأ الجسم فقط.
 */
export class TooManyRequestsError extends AppError {
  constructor(message: string, retryAfterSeconds: number) {
    super(message, 429, { retryAfterSeconds });
    this.headers = { "Retry-After": String(retryAfterSeconds) };
  }
}

/** ما يحتاجه الخادم لإرسال رد الخطأ: الرمز، والجسم، والترويسات الإضافية إن وُجدت. */
export interface ErrorResponse {
  statusCode: number;
  /** الشكل الموحد لكل أخطاء الـ API: { "error": { "message": ..., "details": ... } } */
  body: { error: { message: string; details: unknown } };
  headers?: Record<string, string>;
}

/**
 * يحوّل أي خطأ إلى رد HTTP. يستدعيها onError في server.ts فقط.
 *
 *   - خطأ معروف (AppError أو أي صنف يرثه): رمزه ورسالته وتفاصيله كما هي.
 *   - أي خطأ آخر (خطأ برمجي، أو خطأ من مكتبة): 500 برسالة عامة "Internal server error".
 *     الرسالة الحقيقية لا تُرسل للعميل أبداً، لأنها قد تكشف تفاصيل داخلية؛
 *     server.ts يكتبها في سجل الخادم فقط.
 */
export function toErrorResponse(err: unknown): ErrorResponse {
  if (err instanceof AppError) {
    return {
      statusCode: err.statusCode,
      // "?? null" حتى يظهر الحقل details دائماً في JSON (لو بقي undefined لحذفه JSON.stringify).
      body: { error: { message: err.message, details: err.details ?? null } },
      headers: err.headers,
    };
  }
  return {
    statusCode: 500,
    body: { error: { message: "Internal server error", details: null } },
  };
}
