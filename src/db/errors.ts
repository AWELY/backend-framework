import { AppError, ConflictError, ValidationError } from "../engine/errors";

/**
 * يحوّل أخطاء PostgreSQL التي هي في الحقيقة خطأ العميل إلى خطأ HTTP المناسب، بدل أن
 * تظهر كخطأ 500 (عطل في الخادم).
 *
 * القاعدة تفرض هذه القواعد بنفسها على أي حال (قيود الجداول): slug لا يتكرر، والقسم المشار
 * إليه يجب أن يكون موجوداً، والمخزون لا يكون سالباً. هذه الدالة تقرر فقط كيف يُبلَّغ العميل.
 *
 * رموز PostgreSQL المترجمة:
 *   23505 unique_violation        قيمة يجب أن تكون فريدة تكررت   409، مثل بريد مسجل من قبل
 *   23503 foreign_key_violation   إشارة إلى سجل غير موجود         400، مثل categoryId غير موجود
 *   23514 check_violation         قيمة تخالف قيد CHECK            400، مثل كمية سالبة
 *   22P02 invalid_text            قيمة بصيغة خاطئة                 400، مثل UUID معطوب
 * أي رمز آخر يبقى كما هو، فيصبح 500 ويُسجَّل في سجل الخادم.
 *
 * نص detail الذي يرسله PostgreSQL لا يُمرَّر للعميل عمداً، لأنه قد يعيد قيماً مخزنة
 * (مثل بريد زبون آخر). نرسل فقط اسم القيد (constraint) ليعرف المطوّر أي قاعدة خولفت.
 */
export function translateDbError(err: unknown): unknown {
  // خطأ معروف أصلاً (رماه كودنا): نتركه كما هو.
  if (err instanceof AppError) return err;
  // أخطاء مكتبة pg تحمل code (رمز PostgreSQL) و constraint (اسم القيد).
  const { code, constraint } = err as { code?: string; constraint?: string };
  switch (code) {
    case "23505": // unique_violation
      return new ConflictError("A record with the same unique value already exists", { constraint });
    case "23503": // foreign_key_violation
      return new ValidationError("A referenced record does not exist", { constraint });
    case "23514": // check_violation
      return new ValidationError("A value violates a database rule", { constraint });
    case "22P02": // invalid_text_representation، مثل UUID معطوب
      return new ValidationError("A value has an invalid format");
    default:
      return err;
  }
}
