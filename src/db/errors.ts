import { AppError, ConflictError, ErrorCodes, ServiceUnavailableError, ValidationError } from "../engine/errors";

/**
 * يحوّل أخطاء PostgreSQL التي هي في الحقيقة خطأ العميل، أو حالة مؤقتة، إلى خطأ HTTP المناسب،
 * بدل أن تظهر كخطأ 500 (عطل في الخادم).
 *
 * القاعدة تفرض هذه القواعد بنفسها على أي حال (قيود الجداول): slug لا يتكرر، والقسم المشار
 * إليه يجب أن يكون موجوداً، والمخزون لا يكون سالباً. هذه الدالة تقرر فقط كيف يُبلَّغ العميل.
 *
 * رموز PostgreSQL المترجمة:
 *   23505 unique_violation        قيمة يجب أن تكون فريدة تكررت    409 DUPLICATE_VALUE، مثل بريد مسجل من قبل
 *   23503 foreign_key_violation   إشارة إلى سجل غير موجود          400 REFERENCE_NOT_FOUND، مثل categoryId غير موجود
 *   23514 check_violation         قيمة تخالف قيد CHECK             400، مثل كمية سالبة
 *   22P02 invalid_text            قيمة بصيغة خاطئة                  400، مثل UUID معطوب
 *   40P01 deadlock_detected       معاملتان تنتظر كل منهما الأخرى     503 TRANSACTION_CONFLICT (يُعاد تلقائياً)
 *   40001 serialization_failure   تعارض في مستوى عزل SERIALIZABLE   503 TRANSACTION_CONFLICT (يُعاد تلقائياً)
 *   57014 query_canceled          تجاوز statement_timeout           503 QUERY_TIMEOUT
 *   55P03 lock_not_available      قفل مشغول (مع NOWAIT)             503
 *   53300 too_many_connections    القاعدة وصلت حد الاتصالات         503
 *   08xxx / 57P01-3 / ECONNREFUSED... القاعدة متوقفة أو الاتصال انقطع  503 DATABASE_UNAVAILABLE
 * أي رمز آخر يبقى كما هو، فيصبح 500 ويُسجَّل في سجل الخادم.
 *
 * نص detail الذي يرسله PostgreSQL لا يُمرَّر للعميل عمداً، لأنه قد يعيد قيماً مخزنة
 * (مثل بريد زبون آخر). نرسل فقط اسم القيد (constraint) ليعرف المطوّر أي قاعدة خولفت.
 */
/** أخطاء الاتصال نفسه (لا خطأ في الاستعلام): القاعدة متوقفة، أو أُعيد تشغيلها، أو الشبكة انقطعت. */
const CONNECTION_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "EPIPE", "57P01", "57P02", "57P03"]);

export function translateDbError(err: unknown): unknown {
  if (err instanceof AppError) return err;
  const { code, constraint, message } = (err ?? {}) as { code?: string; constraint?: string; message?: string };
  if (
    (code && (CONNECTION_ERROR_CODES.has(code) || code.startsWith("08"))) ||
    /timeout exceeded when trying to connect|Connection terminated/i.test(message ?? "")
  ) {
    return new ServiceUnavailableError("The database is unavailable, please retry", 5, ErrorCodes.DATABASE_UNAVAILABLE);
  }
  switch (code) {
    case "23505": // unique_violation
      return new ConflictError("A record with the same unique value already exists", { constraint }, ErrorCodes.DUPLICATE_VALUE);
    case "23503": // foreign_key_violation
      return new ValidationError("A referenced record does not exist", { constraint }, ErrorCodes.REFERENCE_NOT_FOUND);
    case "23514": // check_violation
      return new ValidationError("A value violates a database rule", { constraint });
    case "22P02": // invalid_text_representation، مثل UUID معطوب
      return new ValidationError("A value has an invalid format");
    case "40P01": // deadlock_detected
    case "40001": // serialization_failure
      return new ServiceUnavailableError("The database is busy, please retry", 1, ErrorCodes.TRANSACTION_CONFLICT, true);
    case "57014": // query_canceled (statement_timeout)
      return new ServiceUnavailableError("The database took too long to answer", 2, ErrorCodes.QUERY_TIMEOUT);
    case "55P03": // lock_not_available
    case "53300": // too_many_connections
      return new ServiceUnavailableError("The database is busy, please retry", 2);
    default:
      return err;
  }
}

/** هل الخطأ تعارض مؤقت تنجح إعادة المعاملة بعده؟ (deadlock أو serialization failure) */
export function isRetryableTransactionError(err: unknown): boolean {
  if (err instanceof ServiceUnavailableError) return err.retryable;
  const code = (err as { code?: string } | null)?.code;
  return code === "40P01" || code === "40001";
}
