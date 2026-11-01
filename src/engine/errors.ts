/**
 * أنواع الأخطاء المركزية في الإطار.
 *
 * أي خطأ يريد الإطار، أو متجر مبني عليه، أن يتحول إلى رد HTTP برمز محدد، يجب أن يرث
 * من AppError. كل صنف هنا يحمل رمز الحالة الخاص به، ورمزاً نصياً ثابتاً (code) تقرؤه البرامج:
 *
 *   ValidationError          400  VALIDATION_FAILED     طلب غير صالح (JSON معطوب، حقل ناقص أو غير معروف)
 *   UnauthorizedError        401  UNAUTHORIZED          لا نعرف من أنت (لا توكن، أو توكن غير صالح)
 *   ForbiddenError           403  FORBIDDEN             نعرفك، لكن ليست لديك الصلاحية
 *   NotFoundError            404  NOT_FOUND             غير موجود
 *   MethodNotAllowedError    405  METHOD_NOT_ALLOWED    المسار موجود، لكن ليس بهذه الطريقة (ومعه ترويسة Allow)
 *   ConflictError            409  CONFLICT              تعارض مع الحالة الحالية (مخزون لا يكفي، بريد مسجل من قبل)
 *   PreconditionFailedError  412  PRECONDITION_FAILED   If-Match لا يطابق النسخة الحالية (عدّل غيرك قبلك)
 *   PayloadTooLargeError     413  PAYLOAD_TOO_LARGE     جسم الطلب أكبر من الحد
 *   TooManyRequestsError     429  RATE_LIMITED          محاولات كثيرة، ومعه ترويسة Retry-After
 *   BadGatewayError          502  BAD_GATEWAY           خدمة خارجية (بوابة دفع) فشلت
 *   ServiceUnavailableError  503  SERVICE_UNAVAILABLE   الخادم مشغول مؤقتاً، أعد المحاولة (ومعه Retry-After)
 *
 * لماذا code بجانب message؟ الرسالة للبشر وقد تتغير صياغتها، أما code فعقد ثابت: الموقع يكتب
 * if (error.code === "INSUFFICIENT_STOCK") بدل أن يقارن نص الرسالة. الأخطاء المحددة تمرر رمزاً
 * أدق من الافتراضي، مثل INSUFFICIENT_STOCK بدل CONFLICT. القائمة الكاملة في ErrorCodes أدناه.
 *
 * و toErrorResponse هي المكان الوحيد الذي يقرر كيف يتحول أي خطأ إلى رد HTTP.
 * مكانها هنا في المحرك (engine) وليس في middleware/، لأن الخادم نفسه يحتاجها في حالات
 * لا يراها أي middleware: مسار غير موجود، أو جسم JSON معطوب (انظر engine/http/server.ts).
 */

/**
 * كل الرموز التي يصدرها الإطار نفسه. الإضافات تستطيع استخدام رموزها الخاصة بنفس الشكل
 * (حروف كبيرة وشرطة سفلية)، مثل "INVALID_COUPON".
 */
export const ErrorCodes = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  MALFORMED_JSON: "MALFORMED_JSON",
  MALFORMED_URL: "MALFORMED_URL",
  UNAUTHORIZED: "UNAUTHORIZED",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  INVALID_TOKEN: "INVALID_TOKEN",
  INVALID_API_KEY: "INVALID_API_KEY",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
  CONFLICT: "CONFLICT",
  DUPLICATE_VALUE: "DUPLICATE_VALUE",
  REFERENCE_NOT_FOUND: "REFERENCE_NOT_FOUND",
  INSUFFICIENT_STOCK: "INSUFFICIENT_STOCK",
  CART_CHECKED_OUT: "CART_CHECKED_OUT",
  CART_EMPTY: "CART_EMPTY",
  PRODUCT_UNAVAILABLE: "PRODUCT_UNAVAILABLE",
  VARIANT_REQUIRED: "VARIANT_REQUIRED",
  INVALID_STATUS_TRANSITION: "INVALID_STATUS_TRANSITION",
  INVALID_PAYMENT_TRANSITION: "INVALID_PAYMENT_TRANSITION",
  ORDER_NOT_REFUNDABLE: "ORDER_NOT_REFUNDABLE",
  REFUND_EXCEEDS_PAID: "REFUND_EXCEEDS_PAID",
  INVALID_RESET_TOKEN: "INVALID_RESET_TOKEN",
  IDEMPOTENCY_IN_PROGRESS: "IDEMPOTENCY_IN_PROGRESS",
  IDEMPOTENCY_KEY_REUSED: "IDEMPOTENCY_KEY_REUSED",
  PRECONDITION_FAILED: "PRECONDITION_FAILED",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  RATE_LIMITED: "RATE_LIMITED",
  BAD_GATEWAY: "BAD_GATEWAY",
  PAYMENT_PROVIDER_ERROR: "PAYMENT_PROVIDER_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  TRANSACTION_CONFLICT: "TRANSACTION_CONFLICT",
  QUERY_TIMEOUT: "QUERY_TIMEOUT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

/** الرمز الافتراضي لكل رمز حالة، حين لا يمرر الخطأ رمزاً أدق. */
function defaultCode(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return ErrorCodes.VALIDATION_FAILED;
    case 401:
      return ErrorCodes.UNAUTHORIZED;
    case 403:
      return ErrorCodes.FORBIDDEN;
    case 404:
      return ErrorCodes.NOT_FOUND;
    case 405:
      return ErrorCodes.METHOD_NOT_ALLOWED;
    case 409:
      return ErrorCodes.CONFLICT;
    case 412:
      return ErrorCodes.PRECONDITION_FAILED;
    case 413:
      return ErrorCodes.PAYLOAD_TOO_LARGE;
    case 429:
      return ErrorCodes.RATE_LIMITED;
    case 502:
      return ErrorCodes.BAD_GATEWAY;
    case 503:
      return ErrorCodes.SERVICE_UNAVAILABLE;
    default:
      return ErrorCodes.INTERNAL_ERROR;
  }
}

/**
 * الأب لكل الأخطاء المعروفة. استخدامه في أي مكان:
 *   throw new NotFoundError("Product not found");
 * والخطأ يصل وحده إلى onError في server.ts، فيتحول إلى رد 404 بالشكل الموحد.
 */
export class AppError extends Error {
  /** رمز حالة HTTP، مثل 404. readonly: لا يتغير بعد إنشاء الخطأ. */
  readonly statusCode: number;
  /** الرمز النصي الثابت الذي تقرؤه البرامج، مثل "INSUFFICIENT_STOCK". */
  readonly code: string;
  /** تفاصيل إضافية تُرسل للعميل، مثل قائمة الحقول الخاطئة في ValidationError. */
  readonly details?: unknown;
  /** ترويسات إضافية للرد، مثل Retry-After مع 429. */
  headers?: Record<string, string>;

  constructor(message: string, statusCode = 500, details?: unknown, code?: string) {
    super(message);
    // new.target هو الصنف الذي أُنشئ فعلاً (مثل NotFoundError وليس AppError)،
    // فيظهر اسمه الصحيح في السجل وفي الـ stack.
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code ?? defaultCode(statusCode);
    this.details = details;
    // يجعل الـ stack يبدأ من مكان رمي الخطأ، لا من داخل هذا الـ constructor.
    // و "?." لأن captureStackTrace موجودة في Node وليست في كل بيئات JavaScript.
    Error.captureStackTrace?.(this, new.target);
  }
}

/** 400: المدخلات غير صالحة. details تحمل كل المشاكل معاً، مثل [{ field, message }]. */
export class ValidationError extends AppError {
  constructor(message = "Validation failed", details?: unknown, code?: string) {
    super(message, 400, details, code);
  }
}

/** 401: المصادقة مطلوبة أو فشلت (لا نعرف من أنت). */
export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized", code?: string) {
    super(message, 401, undefined, code);
  }
}

/** 403: نعرف من أنت، لكن دورك لا يملك الصلاحية المطلوبة. */
export class ForbiddenError extends AppError {
  constructor(message = "Forbidden", code?: string) {
    super(message, 403, undefined, code);
  }
}

/** 404: الشيء المطلوب غير موجود، أو لا يحق لك معرفة أنه موجود (مثل سلة غيرك). */
export class NotFoundError extends AppError {
  constructor(message = "Not found", code?: string) {
    super(message, 404, undefined, code);
  }
}

/**
 * 405: المسار موجود لكن ليس بهذه الطريقة، مثل DELETE /health.
 * ترويسة Allow تخبر العميل بالطرق المسموحة (يطلبها معيار HTTP مع 405).
 */
export class MethodNotAllowedError extends AppError {
  constructor(method: string, path: string, allowed: readonly string[]) {
    super(`Method ${method} is not allowed on ${path}`, 405, { allowed });
    this.headers = { Allow: allowed.join(", ") };
  }
}

/** 409: الطلب صحيح، لكنه يتعارض مع الحالة الحالية، مثل مخزون لا يكفي أو سلة اشتُريت من قبل. */
export class ConflictError extends AppError {
  constructor(message = "Conflict", details?: unknown, code?: string) {
    super(message, 409, details, code);
  }
}

/**
 * 412: أرسل العميل If-Match برقم نسخة قديم: أحد غيره عدّل السجل بعد أن قرأه.
 * بدونه يكتب آخر من يحفظ فوق تعديل من سبقه دون أن يعلم (Lost update).
 */
export class PreconditionFailedError extends AppError {
  constructor(message = "The resource was modified by someone else", details?: unknown) {
    super(message, 412, details);
  }
}

/** 413: جسم الطلب أكبر من الحد المسموح (bodyLimitBytes في createServer). */
export class PayloadTooLargeError extends AppError {
  constructor(limitBytes: number) {
    super(`Request body is larger than ${limitBytes} bytes`, 413, { limitBytes });
  }
}

/**
 * 429: محاولات كثيرة (حد المحاولات في الدخول والتسجيل وغيرهما).
 * يضع ترويسة Retry-After بعدد الثواني، فيعرف العميل متى يحاول من جديد،
 * ويضعها أيضاً في details لمن يقرأ الجسم فقط.
 */
export class TooManyRequestsError extends AppError {
  constructor(message: string, retryAfterSeconds: number) {
    super(message, 429, { retryAfterSeconds });
    this.headers = { "Retry-After": String(retryAfterSeconds) };
  }
}

/** 502: خدمة خارجية نعتمد عليها فشلت، مثل بوابة دفع رفضت الاسترجاع. */
export class BadGatewayError extends AppError {
  constructor(message = "An upstream service failed", details?: unknown, code?: string) {
    super(message, 502, details, code);
  }
}

/**
 * 503: الخادم لا يستطيع الخدمة الآن لسبب مؤقت (قاعدة مشغولة، أو إيقاف جارٍ).
 * retryable = true تعني أن إعادة نفس العملية قد تنجح (يستخدمها withTransaction).
 */
export class ServiceUnavailableError extends AppError {
  readonly retryable: boolean;
  constructor(message = "Service temporarily unavailable", retryAfterSeconds = 1, code?: string, retryable = false) {
    super(message, 503, { retryAfterSeconds }, code);
    this.headers = { "Retry-After": String(retryAfterSeconds) };
    this.retryable = retryable;
  }
}

/** ما يحتاجه الخادم لإرسال رد الخطأ: الرمز، والجسم، والترويسات الإضافية إن وُجدت. */
export interface ErrorResponse {
  statusCode: number;
  /** الشكل الموحد لكل أخطاء الـ API. requestId يربط الرد بسطر السجل في الخادم. */
  body: { error: { code: string; message: string; details: unknown; requestId: string | null } };
  headers?: Record<string, string>;
}

/**
 * يحوّل أي خطأ إلى رد HTTP. يستدعيها onError في server.ts فقط.
 *
 *   - خطأ معروف (AppError أو أي صنف يرثه): رمزه ورسالته وتفاصيله كما هي.
 *   - أي خطأ آخر (خطأ برمجي، أو خطأ من مكتبة): 500 برسالة عامة "Internal server error".
 *     الرسالة الحقيقية لا تُرسل للعميل أبداً، لأنها قد تكشف تفاصيل داخلية؛
 *     server.ts يكتبها في سجل الخادم فقط، ومعها requestId نفسه الذي يصل للعميل.
 */
export function toErrorResponse(err: unknown, requestId?: string): ErrorResponse {
  if (err instanceof AppError) {
    return {
      statusCode: err.statusCode,
      // "?? null" حتى يظهر الحقل details دائماً في JSON (لو بقي undefined لحذفه JSON.stringify).
      body: { error: { code: err.code, message: err.message, details: err.details ?? null, requestId: requestId ?? null } },
      headers: err.headers,
    };
  }
  return {
    statusCode: 500,
    body: {
      error: {
        code: ErrorCodes.INTERNAL_ERROR,
        message: "Internal server error",
        details: null,
        requestId: requestId ?? null,
      },
    },
  };
}
