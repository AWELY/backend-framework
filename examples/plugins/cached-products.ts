import { PRODUCTS_REPOSITORY, ProductsRepository, type CommercePlugin, type Product, type Queryable } from "./maa";

/**
 * مثال استبدال خدمة عبر حاوية الـ DI، دون تعديل أي سطر في الإطار:
 * مستودع منتجات يحفظ نتيجة findById في الذاكرة لمدة قصيرة، فلا يسأل القاعدة عن نفس المنتج
 * مع كل زيارة لصفحته.
 *
 * كيف يعمل الاستبدال؟ وحدة المنتجات تطلب مستودعها من الحاوية عند كل طلب
 * (container.resolve(PRODUCTS_REPOSITORY))، والإضافات تُهيَّأ بعد الوحدات، فتسجيل نفس الرمز هنا
 * يستبدل الوصفة. الكتابة (إنشاء، تعديل، حذف) تمر بمعاملة بمستودع جديد، والذاكرة تُمسح بحدث
 * product.updated و product.deleted.
 */
class CachedProductsRepository extends ProductsRepository {
  private readonly cache = new Map<string, { at: number; value: Product | null }>();

  constructor(
    db: Queryable,
    private readonly ttlMs: number
  ) {
    super(db);
  }

  /** عدد مرات الإجابة من الذاكرة (للاختبار). */
  hits = 0;

  override async findById(id: string): Promise<Product | null> {
    const cached = this.cache.get(id);
    if (cached && Date.now() - cached.at < this.ttlMs) {
      this.hits++;
      return cached.value;
    }
    const value = await super.findById(id);
    this.cache.set(id, { at: Date.now(), value });
    return value;
  }

  forget(id: string): void {
    this.cache.delete(id);
  }
}

export function cachedProducts(options: { ttlMs?: number } = {}): CommercePlugin {
  return {
    name: "cached-products",
    version: "1.0.0",
    dependsOn: ["products"],
    setup({ container, pool, extensions }) {
      const repo = new CachedProductsRepository(pool, options.ttlMs ?? 30_000);
      container.register(PRODUCTS_REPOSITORY, () => repo);
      extensions.on("product.updated", ({ product }) => repo.forget(product.id));
      extensions.on("product.deleted", ({ productId }) => repo.forget(productId));
    },
  };
}
