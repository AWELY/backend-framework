import type { Migration } from "../../db/migrations";
import type { Infer, Schema } from "../../engine/validation";
import { SLUG_PATTERN } from "../shared";

/**
 * جدول الأقسام (أول جدول في المشروع، رقم 0100):
 *   id          : UUID تولّده القاعدة نفسها (gen_random_uuid).
 *   name        : اسم القسم، مثل "شواحن".
 *   slug        : اسم مختصر للروابط، مثل "chargers". UNIQUE: لا يتكرر في الجدول.
 *   description : وصف اختياري (يقبل NULL).
 *   created_at و updated_at : وقت الإنشاء وآخر تعديل. TIMESTAMPTZ تحفظ المنطقة الزمنية.
 */
export const categoriesMigrations: Migration[] = [
  {
    id: "0100_create_categories",
    up: `
      CREATE TABLE categories (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name        TEXT NOT NULL,
        slug        TEXT NOT NULL UNIQUE,
        description TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
  {
    // رقم النسخة للتعديل المتفائل (ETag و If-Match): يزيد مع كل تعديل.
    id: "0930_categories_version",
    up: `ALTER TABLE categories ADD COLUMN version INTEGER NOT NULL DEFAULT 1;`,
  },
];

/**
 * قواعد التحقق لإنشاء قسم أو تعديله (يستخدمها validateBody).
 *
 * "as const" تجعل TypeScript يحفظ القيم حرفياً (مثل type: "string" وليس أي نص)،
 * و "satisfies Schema" تتأكد أن الشكل صحيح، دون أن تمحو هذه التفاصيل.
 * بهذا يستطيع Infer أن يستنتج النوع الدقيق للبيانات.
 */
export const categoryInputSchema = {
  name: { type: "string", minLength: 1, maxLength: 120 },
  slug: { type: "string", minLength: 1, maxLength: 120, pattern: SLUG_PATTERN },
  description: { type: "string", maxLength: 2000, optional: true, nullable: true },
} as const satisfies Schema;

/** نوع البيانات بعد التحقق، يُستنتج من الـ schema: { name: string; slug: string; description?: string } */
export type CategoryInput = Infer<typeof categoryInputSchema>;

/** شكل القسم في ردود الـ API (أسماء الحقول بأسلوب camelCase). */
export interface Category {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  /** رقم النسخة، يزيد مع كل تعديل (يعود أيضاً في ترويسة ETag). */
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
