/**
 * شكل UUID: 32 رقماً سداسياً في خمس مجموعات (8-4-4-4-12)،
 * مثل 3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c. والحرف i في النهاية يعني "لا فرق بين الكبير والصغير".
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * هل هذا النص UUID صالح؟
 *
 * كل الجداول مفتاحها الأساسي UUID، فأي قيمة أخرى في متغير المسار (:id) لا يمكن أن تطابق
 * أي صف. لذلك تفحصها المستودعات قبل الاستعلام: "/products/abc" يعطي "غير موجود" مباشرة،
 * دون استعلام، ودون خطأ صيغة من PostgreSQL.
 *
 * لماذا UUID وليس أرقاماً متسلسلة (1، 2، 3)؟ لا يمكن تخمين رقم طلب شخص آخر، ولا معرفة
 * عدد طلبات المتجر من رقم طلبك.
 */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** نفس النمط، للاستخدام في الـ schemas (مثلاً productId: { type: "string", pattern: UUID_REGEX }). */
export const UUID_REGEX = UUID_PATTERN;
