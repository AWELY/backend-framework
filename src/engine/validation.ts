import { ValidationError } from "./errors";

/**
 * مدقّق صغير لمدخلات الطلبات (schema validator).
 *
 * لماذا لم نستخدم مكتبة مثل zod أو joi؟ لنفس سبب كتابة الـ Router وحاوية الـ DI بأنفسنا:
 * احتياجاتنا صغيرة (حقول نصية ورقمية ومنطقية مع قيود قليلة)، فلا تبرر اعتمادية إضافية.
 *
 * القواعد:
 *   - كل حقل مطلوب إلا إذا كُتب فيه optional: true.
 *   - أي حقل غير موجود في الـ schema يُرفض. هذا يمنع العميل من دسّ حقول لم نسمح بها،
 *     مثل "role" أو "price" في مسار لا يجب أن يقبلها. اسم هذه الحماية: Mass assignment.
 *   - كل المشاكل تُجمع وتُرسل معاً في رد واحد، لا الأولى فقط.
 *
 * مثال schema (من src/modules/cart/cart.schema.ts):
 *   productId: { type: "string", pattern: UUID_REGEX },
 *   quantity: { type: "number", integer: true, min: 1, max: 1000 },
 */

/** قاعدة حقل واحد. نوعه يحدد القيود المسموحة معه. */
export type FieldRule =
  | {
      type: "string";
      optional?: boolean;
      /** أقل عدد حروف. */
      minLength?: number;
      /** أكثر عدد حروف. */
      maxLength?: number;
      /** شكل النص المطلوب، مثل البريد الإلكتروني أو رابط الصورة. */
      pattern?: RegExp;
      /** القيم المسموحة فقط، مثل حالات الطلب. */
      oneOf?: readonly string[];
    }
  | { type: "number"; optional?: boolean; min?: number; max?: number; integer?: boolean }
  | { type: "boolean"; optional?: boolean };

/** الـ schema: اسم كل حقل وقاعدته. */
export type Schema = Record<string, FieldRule>;

// ما يلي أنواع TypeScript فقط (لا تعمل وقت التشغيل): تستنتج من الـ schema نوع البيانات بعد التحقق.

/** نوع قيمة الحقل حسب قاعدته: "string" يعطي string، و "number" يعطي number، وإلا boolean. */
type FieldValue<R extends FieldRule> = R extends { type: "string" }
  ? string
  : R extends { type: "number" }
    ? number
    : boolean;

/** أسماء الحقول المطلوبة: كل حقل ليس فيه optional: true. */
type RequiredKeys<S extends Schema> = { [K in keyof S]: S[K] extends { optional: true } ? never : K }[keyof S];
/** أسماء الحقول الاختيارية: الباقي. */
type OptionalKeys<S extends Schema> = Exclude<keyof S, RequiredKeys<S>>;

/**
 * نوع TypeScript الذي ينتجه الـ schema، مثل { name: string; stock?: number }.
 * فائدته: الـ handler يحصل على بيانات بنوع صحيح دون أن نكتب النوع مرتين.
 */
export type Infer<S extends Schema> = { [K in RequiredKeys<S>]: FieldValue<S[K]> } & {
  [K in OptionalKeys<S>]?: FieldValue<S[K]>;
};

/** مشكلة في حقل واحد، تُرسل للعميل داخل details. مثال: { field: "quantity", message: "must be >= 1" } */
export interface FieldIssue {
  field: string;
  message: string;
}

/** يفحص قيمة حقل واحد. يرجع null إن كانت صحيحة، أو نص المشكلة. */
function checkField(field: string, rule: FieldRule, value: unknown): string | null {
  switch (rule.type) {
    case "string": {
      if (typeof value !== "string") return "must be a string";
      if (rule.minLength !== undefined && value.length < rule.minLength)
        return `must be at least ${rule.minLength} characters`;
      if (rule.maxLength !== undefined && value.length > rule.maxLength)
        return `must be at most ${rule.maxLength} characters`;
      if (rule.pattern && !rule.pattern.test(value)) return "has an invalid format";
      if (rule.oneOf && !rule.oneOf.includes(value)) return `must be one of: ${rule.oneOf.join(", ")}`;
      return null;
    }
    case "number": {
      // Number.isFinite يرفض NaN و Infinity (لا تأتي من JSON عادة، لكنه احتياط).
      if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number";
      // integer: يرفض الكسور، مثل كمية 1.5 أو سعر 10.25 (المبالغ عندنا أرقام صحيحة بالدرهم).
      if (rule.integer && !Number.isInteger(value)) return "must be an integer";
      if (rule.min !== undefined && value < rule.min) return `must be >= ${rule.min}`;
      if (rule.max !== undefined && value > rule.max) return `must be <= ${rule.max}`;
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : "must be true or false";
  }
  // لا يُفترض الوصول إلى هنا (كل الأنواع غُطّيت أعلاه)، لكنه احتياط لنوع غير معروف.
  return `unsupported rule for ${field}`;
}

/**
 * يتحقق من input حسب schema، ويرجع حقول الـ schema فقط (أي شيء آخر لا يمر).
 * مع partial: true يصبح كل حقل اختيارياً، ويُستخدم لطلبات PATCH (تعديل جزء من البيانات).
 * يرمي ValidationError (رد 400) بكل المشاكل معاً.
 *
 * السطران التاليان "تحميل زائد" (Overloads): يخبران TypeScript أن نوع النتيجة يعتمد على partial:
 *   - مع partial: true تكون النتيجة Partial<Infer<S>>، أي كل الحقول اختيارية.
 *   - بدونه تكون Infer<S>، أي الحقول المطلوبة موجودة حتماً.
 */
export function validate<S extends Schema>(schema: S, input: unknown, options: { partial: true }): Partial<Infer<S>>;
export function validate<S extends Schema>(schema: S, input: unknown, options?: { partial?: false }): Infer<S>;
export function validate<S extends Schema>(
  schema: S,
  input: unknown,
  options: { partial?: boolean } = {}
): Infer<S> | Partial<Infer<S>> {
  // الجسم يجب أن يكون كائناً: لا نص، ولا null، ولا مصفوفة (typeof المصفوفة "object" أيضاً).
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  const data = input as Record<string, unknown>;
  const issues: FieldIssue[] = [];
  // نبني كائناً جديداً فيه حقول الـ schema فقط، ولا نرجع input نفسه.
  const output: Record<string, unknown> = {};

  // 1. أي حقل أرسله العميل وليس في الـ schema يُرفض (الحماية من Mass assignment).
  for (const key of Object.keys(data)) {
    if (!(key in schema)) issues.push({ field: key, message: "is not an allowed field" });
  }

  // 2. نفحص كل حقل في الـ schema.
  for (const [field, rule] of Object.entries(schema)) {
    const value = data[field];
    // الحقل غير موجود (أو null): خطأ إن كان مطلوباً، إلا في وضع partial.
    if (value === undefined || value === null) {
      if (!rule.optional && !options.partial) issues.push({ field, message: "is required" });
      continue;
    }
    const problem = checkField(field, rule, value);
    if (problem) issues.push({ field, message: problem });
    else output[field] = value;
  }

  // 3. إن وُجدت أي مشكلة، نرد بها كلها معاً في details.
  if (issues.length > 0) throw new ValidationError("Validation failed", issues);
  return output as Infer<S>;
}
