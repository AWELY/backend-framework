/**
 * الرمز (Token): مفتاح فريد تُسجَّل به خدمة في الحاوية وتُطلب به.
 *
 * هو Symbol عادي (قيمة فريدة لا تتكرر أبداً، حتى لو تشابه الوصف)، ومعه "نوع وهمي"
 * (Phantom type) لا وجود له وقت التشغيل: الحقل __type يحمل نوع الخدمة لـ TypeScript فقط.
 * بفضله، Container.resolve(PRODUCTS_REPOSITORY) ترجع ProductsRepository بنوعها الصحيح،
 * دون decorators ودون مكتبة reflect-metadata (التي تتطلب الإعداد experimentalDecorators
 * ومكتبة إضافية، وهذا وزن حقيقي لا يحتاجه المشروع).
 *
 * كل وحدة تصدّر رموزها، مثلاً في src/modules/products:
 *   export const PRODUCTS_REPOSITORY = createToken<ProductsRepository>("ProductsRepository");
 *
 * لماذا Symbol وليس نصاً مثل "ProductsRepository"؟ نصّان متشابهان من وحدتين مختلفتين
 * قد يتصادمان. أما رمزان من نوع Symbol فلا يتساويان أبداً.
 */
export type Token<T> = symbol & { readonly __type?: T };

/** ينشئ رمزاً جديداً. description للقراءة فقط (يظهر في رسائل الخطأ). */
export function createToken<T>(description: string): Token<T> {
  return Symbol(description) as Token<T>;
}
