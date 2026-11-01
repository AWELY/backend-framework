import { ValidationError } from "./errors";

/**
 * مدقّق صغير لمدخلات الطلبات (schema validator).
 *
 * لماذا لم نستخدم مكتبة مثل zod أو joi؟ لنفس سبب كتابة الـ Router وحاوية الـ DI بأنفسنا:
 * احتياجاتنا محددة، فلا تبرر اعتمادية إضافية. القرار وبدائله في docs/adr/0004-in-house-validator.md.
 *
 * القواعد:
 *   - كل حقل مطلوب إلا إذا كُتب فيه optional: true.
 *   - nullable: true تعني أن null قيمة مقبولة لها معنى: "امسح هذا الحقل".
 *     مثال: PATCH /products/:id بجسم { "categoryId": null } يزيل المنتج من قسمه.
 *     في الحقل غير nullable تبقى null مثل "لم يُرسل" (السلوك القديم، حتى لا تنكسر العملاء).
 *   - أي حقل غير موجود في الـ schema يُرفض، على كل المستويات. هذا يمنع العميل من دسّ حقول
 *     لم نسمح بها، مثل "role" أو "price" في مسار لا يجب أن يقبلها. اسم هذه الحماية: Mass assignment.
 *   - كل المشاكل تُجمع وتُرسل معاً في رد واحد، لا الأولى فقط. الحقول المتداخلة تُسمّى بمسارها
 *     الكامل، مثل "restock[1].quantity".
 *
 * الأنواع: string و number و boolean، و object (حقول متداخلة) و array (قائمة عناصر بنفس القاعدة).
 *
 * مثال schema (من src/modules/orders/orders.schema.ts):
 *   amount: { type: "number", integer: true, min: 1 },
 *   restock: { type: "array", optional: true, maxItems: 100, items: {
 *     type: "object", properties: { productId: { type: "string", pattern: UUID_REGEX }, ... } } },
 */

/** خصائص مشتركة بين كل القواعد. */
interface BaseRule {
  optional?: boolean;
  nullable?: boolean;
  /** وصف الحقل، يظهر في OpenAPI. */
  description?: string;
}

/** قاعدة حقل واحد. نوعه يحدد القيود المسموحة معه. */
export type FieldRule =
  | (BaseRule & {
      type: "string";
      /** أقل عدد حروف. */
      minLength?: number;
      /** أكثر عدد حروف. */
      maxLength?: number;
      /** شكل النص المطلوب، مثل البريد الإلكتروني أو رابط الصورة. */
      pattern?: RegExp;
      /** القيم المسموحة فقط، مثل حالات الطلب. */
      oneOf?: readonly string[];
    })
  | (BaseRule & { type: "number"; min?: number; max?: number; integer?: boolean })
  | (BaseRule & { type: "boolean" })
  | (BaseRule & { type: "object"; properties: Schema })
  | (BaseRule & { type: "array"; items: FieldRule; minItems?: number; maxItems?: number });

/** الـ schema: اسم كل حقل وقاعدته. */
export type Schema = { readonly [field: string]: FieldRule };

/** ما يصف مدخلات مسار كاملة: الجسم والاستعلام ومتغيرات المسار (يستخدمه withInput و OpenAPI). */
export interface InputSpec {
  body?: Schema;
  query?: Schema;
  params?: Schema;
  /** كل حقول الجسم اختيارية، لطلبات PATCH. */
  partial?: boolean;
  /** وصف المسار في سطر واحد. */
  summary?: string;
  /** رمز الحالة عند النجاح، مثل 201. */
  successStatus?: number;
  /** المسار يقبل If-Match (التعديل المتفائل). */
  conditional?: boolean;
}

// ما يلي أنواع TypeScript فقط (لا تعمل وقت التشغيل): تستنتج من الـ schema نوع البيانات بعد التحقق.

/** يجعل النوع المركّب يظهر في المحرر كائناً واحداً مقروءاً، بدل A & B. */
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * نوع قيمة الحقل حسب قاعدته:
 *   string مع oneOf يعطي اتحاد القيم نفسها، مثل "pending" | "paid"، وبدونه string.
 *   number يعطي number، و boolean يعطي boolean.
 *   object يعطي نوع حقوله، و array يعطي مصفوفة من نوع عناصره.
 */
type BaseValue<R> = R extends { type: "string"; oneOf: readonly (infer U extends string)[] }
  ? U
  : R extends { type: "string" }
    ? string
    : R extends { type: "number" }
      ? number
      : R extends { type: "boolean" }
        ? boolean
        : R extends { type: "object"; properties: infer P extends Schema }
          ? Infer<P>
          : R extends { type: "array"; items: infer I }
            ? Array<FieldValue<I>>
            : never;

/** nullable: true تضيف null إلى النوع. */
type FieldValue<R> = R extends { nullable: true } ? BaseValue<R> | null : BaseValue<R>;

/** أسماء الحقول المطلوبة: كل حقل ليس فيه optional: true. */
type RequiredKeys<S extends Schema> = { [K in keyof S]: S[K] extends { optional: true } ? never : K }[keyof S];
/** أسماء الحقول الاختيارية: الباقي. */
type OptionalKeys<S extends Schema> = Exclude<keyof S, RequiredKeys<S>>;

/**
 * نوع TypeScript الذي ينتجه الـ schema، مثل { name: string; stock?: number }.
 * فائدته: الـ handler يحصل على بيانات بنوع صحيح دون أن نكتب النوع مرتين.
 */
export type Infer<S extends Schema> = Simplify<
  { [K in RequiredKeys<S>]: FieldValue<S[K]> } & { [K in OptionalKeys<S>]?: FieldValue<S[K]> }
>;

/** مشكلة في حقل واحد، تُرسل للعميل داخل details. مثال: { field: "quantity", message: "must be >= 1" } */
export interface FieldIssue {
  field: string;
  message: string;
}

/** علامة داخلية: "القيمة مرفوضة" (لا نستخدم undefined لأنها قد تكون نتيجة صحيحة لحقل اختياري). */
const INVALID = Symbol("invalid");

/** كائن JSON عادي: ليس null، ولا مصفوفة. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** يفحص قيمة واحدة (ليست null ولا undefined) حسب قاعدتها، ويرجع القيمة النظيفة أو INVALID. */
function checkValue(path: string, rule: FieldRule, value: unknown, issues: FieldIssue[]): unknown {
  const fail = (message: string) => {
    issues.push({ field: path, message });
    return INVALID;
  };
  switch (rule.type) {
    case "string": {
      if (typeof value !== "string") return fail("must be a string");
      if (rule.minLength !== undefined && value.length < rule.minLength)
        return fail(`must be at least ${rule.minLength} characters`);
      if (rule.maxLength !== undefined && value.length > rule.maxLength)
        return fail(`must be at most ${rule.maxLength} characters`);
      if (rule.pattern && !rule.pattern.test(value)) return fail("has an invalid format");
      if (rule.oneOf && !rule.oneOf.includes(value)) return fail(`must be one of: ${rule.oneOf.join(", ")}`);
      return value;
    }
    case "number": {
      // Number.isFinite يرفض NaN و Infinity (لا تأتي من JSON عادة، لكنه احتياط).
      if (typeof value !== "number" || !Number.isFinite(value)) return fail("must be a number");
      // integer: يرفض الكسور، مثل كمية 1.5 أو سعر 10.25 (المبالغ عندنا أرقام صحيحة بأصغر وحدة).
      if (rule.integer && !Number.isSafeInteger(value)) return fail("must be an integer");
      if (rule.min !== undefined && value < rule.min) return fail(`must be >= ${rule.min}`);
      if (rule.max !== undefined && value > rule.max) return fail(`must be <= ${rule.max}`);
      return value;
    }
    case "boolean":
      return typeof value === "boolean" ? value : fail("must be true or false");
    case "object": {
      if (!isPlainObject(value)) return fail("must be an object");
      return checkObject(rule.properties, value, `${path}.`, issues, false);
    }
    case "array": {
      if (!Array.isArray(value)) return fail("must be an array");
      if (rule.minItems !== undefined && value.length < rule.minItems)
        return fail(`must have at least ${rule.minItems} item(s)`);
      if (rule.maxItems !== undefined && value.length > rule.maxItems)
        return fail(`must have at most ${rule.maxItems} item(s)`);
      const out: unknown[] = [];
      let ok = true;
      value.forEach((item, i) => {
        const itemPath = `${path}[${i}]`;
        if (item === null || item === undefined) {
          if (rule.items.nullable && item === null) out.push(null);
          else {
            issues.push({ field: itemPath, message: "is required" });
            ok = false;
          }
          return;
        }
        const checked = checkValue(itemPath, rule.items, item, issues);
        if (checked === INVALID) ok = false;
        else out.push(checked);
      });
      return ok ? out : INVALID;
    }
  }
  // لا يُفترض الوصول إلى هنا (كل الأنواع غُطّيت أعلاه)، لكنه احتياط لنوع غير معروف.
  return fail("has an unsupported rule");
}

/**
 * يفحص كائناً حسب schema، ويبني كائناً جديداً فيه حقول الـ schema فقط.
 * prefix: مسار الكائن نفسه لأسماء الحقول في الأخطاء، مثل "address." (فارغ للمستوى الأعلى).
 */
function checkObject(
  schema: Schema,
  data: Record<string, unknown>,
  prefix: string,
  issues: FieldIssue[],
  partial: boolean
): Record<string, unknown> | typeof INVALID {
  const before = issues.length;
  // نبني كائناً جديداً فيه حقول الـ schema فقط، ولا نرجع data نفسه.
  const output: Record<string, unknown> = {};

  // 1. أي حقل أرسله العميل وليس في الـ schema يُرفض (الحماية من Mass assignment).
  // Object.hasOwn وليس "in": الكلمة in ترى خصائص الأب أيضاً، فكان "constructor" يمر كأنه حقل معروف.
  for (const key of Object.keys(data)) {
    if (!Object.hasOwn(schema, key)) issues.push({ field: `${prefix}${key}`, message: "is not an allowed field" });
  }

  // 2. نفحص كل حقل في الـ schema.
  for (const [field, rule] of Object.entries(schema)) {
    const value = data[field];
    if (value === null && rule.nullable) {
      output[field] = null;
      continue;
    }
    // الحقل غير موجود (أو null في حقل غير nullable): خطأ إن كان مطلوباً، إلا في وضع partial.
    if (value === undefined || value === null) {
      if (!rule.optional && !partial) issues.push({ field: `${prefix}${field}`, message: "is required" });
      continue;
    }
    const checked = checkValue(`${prefix}${field}`, rule, value, issues);
    if (checked !== INVALID) output[field] = checked;
  }
  return issues.length > before ? INVALID : output;
}

/**
 * يتحقق من input حسب schema، ويرجع حقول الـ schema فقط (أي شيء آخر لا يمر).
 * مع partial: true يصبح كل حقل في المستوى الأعلى اختيارياً، ويُستخدم لطلبات PATCH.
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
  if (!isPlainObject(input)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  const issues: FieldIssue[] = [];
  const output = checkObject(schema, input, "", issues, options.partial ?? false);
  // إن وُجدت أي مشكلة، نرد بها كلها معاً في details.
  if (output === INVALID || issues.length > 0) throw new ValidationError("Validation failed", issues);
  return output as Infer<S>;
}

/**
 * يحوّل نصاً من الرابط إلى النوع الذي تطلبه القاعدة. كل ما في الرابط نصوص، فالرقم "20" يصبح 20،
 * و "true" تصبح true. النص الذي لا يتحول يبقى كما هو، فيرفضه الفحص برسالة واضحة ("must be a number").
 */
function coerce(rule: FieldRule, raw: string): unknown {
  if (rule.type === "number" && /^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (rule.type === "boolean") {
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
  }
  return raw;
}

/**
 * يتحقق من الاستعلام (ما بعد "?") أو متغيرات المسار، بعد تحويل النصوص إلى أنواعها.
 *
 * فرق مقصود عن الجسم: المفاتيح غير المعروفة في الاستعلام تُتجاهل ولا تُرفض. الروابط تحمل عادة
 * مفاتيح لا تخصنا (مثل utm_source من حملة إعلانية، أو "_=" لمنع التخزين المؤقت)، ورفضها يكسر
 * روابط حقيقية دون أي فائدة أمنية: لا شيء يُكتب في القاعدة من مفتاح لم نطلبه.
 *
 * الحقل من نوع array يقرأ كل القيم المكررة: "?tag=a&tag=b" تعطي ["a", "b"].
 */
export function validateQuery<S extends Schema>(schema: S, source: URLSearchParams | Record<string, string>): Infer<S> {
  const params = source instanceof URLSearchParams ? source : new URLSearchParams(source);
  const input: Record<string, unknown> = {};
  for (const [field, rule] of Object.entries(schema)) {
    if (rule.type === "array") {
      const all = params.getAll(field);
      if (all.length > 0) input[field] = all.map((v) => coerce(rule.items, v));
    } else {
      const value = params.get(field);
      if (value !== null && value !== "") input[field] = coerce(rule, value);
    }
  }
  return validate(schema, input);
}
