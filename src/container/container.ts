import type { Token } from "./tokens";

/** "وصفة" إنشاء خدمة: دالة تستلم الحاوية (لتطلب منها خدمات أخرى إن احتاجت) وترجع الخدمة. */
type Factory<T> = (container: Container) => T;

/** ما تحفظه الحاوية عن كل خدمة مسجلة. */
interface Registration<T> {
  /** الوصفة. */
  factory: Factory<T>;
  /** true: نسخة واحدة لكل التطبيق (Singleton). false: نسخة جديدة مع كل طلب. */
  singleton: boolean;
  /** النسخة المحفوظة بعد أول إنشاء (للـ Singleton فقط). */
  instance?: T;
}

/**
 * حاوية حقن الاعتماديات (Dependency Injection container)، صغيرة عمداً.
 *
 * المشكلة التي تحلها: وحدة السلة تحتاج مستودع المنتجات ومستودع المخزون. لو استوردتهما
 * مباشرة وأنشأتهما بنفسها، لصارت الوحدات مربوطة ببعضها بإحكام، ولصعب استبدال أي خدمة
 * (مثلاً بنسخة وهمية في الاختبار). الحل: الوحدات لا تنشئ خدمات غيرها، بل تطلبها من الحاوية.
 *
 * طريقة العمل:
 *   1. عند الإقلاع، كل وحدة تسجّل وصفة خدماتها:
 *        container.register(PRODUCTS_REPOSITORY, () => new ProductsRepository(pool));
 *   2. أي وحدة أخرى تطلبها عند الحاجة:
 *        const products = container.resolve(PRODUCTS_REPOSITORY);
 *   3. أول طلب ينشئ الخدمة، وكل طلب بعده يعيد نفس النسخة (Singleton هو الافتراضي).
 *
 * لماذا صغيرة؟ لا decorators، ولا ربط تلقائي عبر قراءة الـ constructor (reflection)،
 * كما في أطر مثل NestJS. ثمن ذلك سطر تسجيل صريح لكل خدمة، والمقابل كود TypeScript
 * عادي وواضح يمكن تتبعه، دون الاعتماد على إطار DI كامل.
 */
export class Container {
  // كل رمز (Token) ووصفته. Map وليس كائناً عادياً، لأن المفاتيح من نوع Symbol.
  private readonly registrations = new Map<Token<unknown>, Registration<unknown>>();

  /**
   * يسجّل وصفة خدمة. لا يُنشئ الخدمة الآن، بل عند أول resolve (إنشاء كسول، Lazy).
   * التسجيل مرة ثانية بنفس الرمز يستبدل الوصفة القديمة.
   */
  register<T>(token: Token<T>, factory: Factory<T>, options: { singleton?: boolean } = {}): void {
    this.registrations.set(token as Token<unknown>, {
      factory: factory as Factory<unknown>,
      singleton: options.singleton ?? true,
    });
  }

  /**
   * يرجع الخدمة المسجلة بهذا الرمز، بنوعها الصحيح في TypeScript (انظر tokens.ts).
   * يرمي خطأ واضحاً إن لم تُسجَّل، وغالباً معناه أن الوحدات سُجّلت بترتيب خاطئ.
   */
  resolve<T>(token: Token<T>): T {
    const registration = this.registrations.get(token as Token<unknown>);
    if (!registration) {
      throw new Error(`No provider registered for token: ${String(token)}`);
    }
    if (registration.singleton) {
      // أول طلب: ننشئ النسخة ونحفظها. الطلبات التالية تعيد المحفوظة.
      if (registration.instance === undefined) {
        registration.instance = registration.factory(this);
      }
      return registration.instance as T;
    }
    // ليست Singleton: نسخة جديدة في كل مرة.
    return registration.factory(this) as T;
  }

  /** هل سُجّلت خدمة بهذا الرمز؟ مفيدة لإضافة تتصرف حسب وجود وحدة أخرى. */
  has(token: Token<unknown>): boolean {
    return this.registrations.has(token as Token<unknown>);
  }
}
