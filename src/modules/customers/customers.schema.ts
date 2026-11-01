import type { Migration } from "../../db/migrations";
import type { Infer, Schema } from "../../engine/validation";
import { UUID_REGEX } from "../../db/ids";

/**
 * جدول الزبائن (0400).
 *   email         : البريد. الفهرس الفريد على lower(email) يمنع تسجيل "Ali@x.ly" و "ali@x.ly"
 *                   كحسابين، لأن المقارنة بعد تحويل الحروف إلى صغيرة.
 *   password_hash : hash كلمة المرور بصيغة scrypt$N$r$p$salt$key (engine/password.ts)، لا الكلمة نفسها.
 *   phone         : اختياري.
 */
export const customersMigrations: Migration[] = [
  {
    // الزبائن المسجلون فقط. الضيف لا يحصل على صف هنا أبداً، وبيانات التواصل الخاصة به
    // تُحفظ في الطلب نفسه (contact_name و contact_phone في جدول orders).
    id: "0400_create_customers",
    up: `
      CREATE TABLE customers (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email         TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        name          TEXT NOT NULL,
        phone         TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX customers_email_key ON customers (lower(email));
    `,
  },
  {
    // رموز استعادة كلمة المرور: نحفظ بصمة الرمز (SHA-256) لا الرمز نفسه، فمن يقرأ القاعدة لا يستطيع
    // استخدامها. الرمز يصلح مرة واحدة (used_at) ولمدة قصيرة (expires_at).
    id: "0975_password_resets",
    up: `
      CREATE TABLE password_resets (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        token_hash  TEXT NOT NULL UNIQUE,
        expires_at  TIMESTAMPTZ NOT NULL,
        used_at     TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX password_resets_customer_idx ON password_resets (customer_id);
    `,
  },
];

/** شكل بريد مبسط: شيء ثم @ ثم شيء ثم نقطة ثم شيء، بلا مسافات. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * شكل الهاتف: "+" اختيارية، ثم رقم، ثم من 5 إلى 29 حرفاً من الأرقام والمسافات والأقواس والشرطات.
 * مقبول: "0912345678" و "+218 91 234 5678". مُصدَّر لأن وحدة الطلبات تستخدمه أيضاً.
 */
export const PHONE = /^\+?[0-9][0-9 ()-]{5,29}$/;

/** جسم التسجيل. */
export const registerSchema = {
  email: { type: "string", maxLength: 254, pattern: EMAIL },
  // الحد الأعلى يمنع أحداً من جعل الخادم يحسب hash لـ "كلمة مرور" حجمها ميجابايت.
  password: { type: "string", minLength: 8, maxLength: 128 },
  name: { type: "string", minLength: 1, maxLength: 120 },
  phone: { type: "string", maxLength: 30, pattern: PHONE, optional: true },
  /** سلة الضيف قبل التسجيل، لتُدمج في حساب الزبون الجديد. */
  guestCartId: { type: "string", pattern: UUID_REGEX, optional: true },
} as const satisfies Schema;

/**
 * جسم الدخول. لا نفحص شكل البريد هنا: أي بريد غير صحيح سيفشل في الدخول على أي حال،
 * برسالة "Invalid email or password" نفسها.
 */
export const loginSchema = {
  email: { type: "string", maxLength: 254 },
  password: { type: "string", maxLength: 128 },
  /** سلة الضيف قبل الدخول، لتُدمج في سلة الزبون. */
  guestCartId: { type: "string", pattern: UUID_REGEX, optional: true },
} as const satisfies Schema;

/** تغيير كلمة المرور وهو داخل: يجب أن يعرف الحالية. */
export const passwordChangeSchema = {
  currentPassword: { type: "string", maxLength: 128 },
  newPassword: { type: "string", minLength: 8, maxLength: 128 },
} as const satisfies Schema;

/** طلب رمز استعادة كلمة المرور. */
export const resetRequestSchema = {
  email: { type: "string", maxLength: 254 },
} as const satisfies Schema;

/** تعيين كلمة مرور جديدة برمز الاستعادة. */
export const resetConfirmSchema = {
  token: { type: "string", minLength: 20, maxLength: 200 },
  password: { type: "string", minLength: 8, maxLength: 128 },
} as const satisfies Schema;

/** استعلام قائمة الزبائن للموظفين: بحث في البريد والاسم والهاتف. */
export const customerListQuery = {
  q: { type: "string", minLength: 1, maxLength: 100, optional: true, description: "Search email, name or phone" },
} as const satisfies Schema;

/** جسم تعديل الملف الشخصي: الاسم والهاتف فقط (ويُستخدم مع partial: true). */
export const profileSchema = {
  name: { type: "string", minLength: 1, maxLength: 120 },
  phone: { type: "string", maxLength: 30, pattern: PHONE, nullable: true },
} as const satisfies Schema;

export type RegisterInput = Infer<typeof registerSchema>;
export type LoginInput = Infer<typeof loginSchema>;
export type ProfileInput = Infer<typeof profileSchema>;

/** شكل الزبون في ردود الـ API، ولا يحتوي password_hash أبداً. */
export interface Customer {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** يوحّد البريد قبل الحفظ والبحث: يحذف المسافات حوله، ويحوّل الحروف إلى صغيرة. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
