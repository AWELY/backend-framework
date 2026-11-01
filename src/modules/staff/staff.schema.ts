import type { Migration } from "../../db/migrations";
import type { Infer, Schema } from "../../engine/validation";
import { PHONE } from "../customers/customers.schema";

/**
 * حسابات الموظفين: مدير، ومشرف، ودعم، ومندوب توصيل... كل حساب ببريد وكلمة مرور ودور واحد.
 *
 * قبلها كان للمحل "مفتاح مالك" واحد يتشاركه الجميع: لا يُعرف من فعل ماذا، ولا يمكن سحب صلاحية
 * موظف غادر إلا بتغيير المفتاح على الجميع. الآن لكل موظف حسابه، ودوره يحدد صلاحياته
 * (DEFAULT_ROLES في engine/access-control.ts)، وكل ما يفعله يُسجَّل باسمه في سجل التدقيق.
 * المفتاح يبقى للمالك ولأدوات الأتمتة (والمالك وحده يدير حسابات الموظفين).
 *
 * إيقاف حساب (isActive: false) أو تغيير دوره يسري فوراً: الجلسات تُلغى، والدور يُقرأ من هنا مع كل طلب.
 */
export const staffMigrations: Migration[] = [
  {
    id: "0980_create_staff",
    up: `
      CREATE TABLE staff (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email         TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        name          TEXT NOT NULL,
        phone         TEXT,
        role          TEXT NOT NULL,
        is_active     BOOLEAN NOT NULL DEFAULT true,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX staff_email_key ON staff (lower(email));
      CREATE INDEX staff_role_idx ON staff (role);
    `,
  },
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const staffLoginSchema = {
  email: { type: "string", maxLength: 254 },
  password: { type: "string", maxLength: 128 },
} as const satisfies Schema;

/** إنشاء حساب موظف (المالك فقط). الدور يُفحص عند الطلب مقابل أدوار جدول الصلاحيات. */
export const createStaffSchema = {
  email: { type: "string", maxLength: 254, pattern: EMAIL },
  password: { type: "string", minLength: 8, maxLength: 128 },
  name: { type: "string", minLength: 1, maxLength: 120 },
  phone: { type: "string", maxLength: 30, pattern: PHONE, optional: true, nullable: true },
  role: { type: "string", minLength: 1, maxLength: 50 },
} as const satisfies Schema;

/** تعديل حساب موظف (المالك فقط). كلمة مرور جديدة هنا تُخرج الموظف من كل أجهزته. */
export const updateStaffSchema = {
  name: { type: "string", minLength: 1, maxLength: 120, optional: true },
  phone: { type: "string", maxLength: 30, pattern: PHONE, optional: true, nullable: true },
  role: { type: "string", minLength: 1, maxLength: 50, optional: true },
  isActive: { type: "boolean", optional: true },
  password: { type: "string", minLength: 8, maxLength: 128, optional: true },
} as const satisfies Schema;

export const staffListQuery = {
  role: { type: "string", maxLength: 50, optional: true, description: "Only staff with this role, e.g. courier" },
  q: { type: "string", minLength: 1, maxLength: 100, optional: true, description: "Search email or name" },
} as const satisfies Schema;

export type CreateStaffInput = Infer<typeof createStaffSchema>;
export type UpdateStaffInput = Infer<typeof updateStaffSchema>;

/** الموظف كما يرد في الـ API (بلا كلمة المرور أبداً). */
export interface Staff {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  role: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
