const { translateDbError } = require("commerce-framework");

/**
 * أدوات صغيرة تتشاركها إضافات المتجر (staff و delivery و customer-orders و reports).
 *
 * هذه الإضافات كلها خاصة بمتجر AMA، وليست جزءاً من الإطار: تستخدم فقط ما يصدّره الإطار
 * للعامة (require("commerce-framework"))، تماماً كما يفعل أي مطور من خارج الفريق.
 * لهذا هي اختبار حقيقي للإطار: إن احتاجت شيئاً غير مُصدَّر، فهذه فجوة في الإطار نفسه.
 */

/**
 * ينفّذ استعلام SQL على المجموعة (pool) أو على اتصال معاملة (client)، ويترجم أخطاء القاعدة
 * إلى أخطاء HTTP مفهومة (translateDbError من الإطار): مثلاً بريد مكرر يصبح 409 بدل 500.
 *
 * القيم تُمرَّر دائماً منفصلة عن نص الاستعلام ($1، $2 ...)، فلا يمكن حقن SQL أبداً.
 */
async function query(db, text, values = []) {
  try {
    return await db.query(text, values);
  } catch (err) {
    throw translateDbError(err);
  }
}

/** يحذف كل ما ليس رقماً من الهاتف: "+218 91-234" تصبح "21891234". لمقارنة هاتفين كُتبا بشكلين. */
const digits = (phone) => String(phone ?? "").replace(/\D/g, "");

/** نفس قاعدة الهاتف في الإطار (PHONE في customers.schema.ts): "+" اختيارية ثم أرقام ومسافات وأقواس. */
const PHONE = /^\+?[0-9][0-9 ()-]{5,29}$/;

/** شكل بريد مبسط، نفس قاعدة الإطار. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = { query, digits, PHONE, EMAIL };
