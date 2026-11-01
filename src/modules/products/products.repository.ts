import { Repository, type ListPage, type Queryable } from "../../db/repository";
import { isUuid } from "../../db/ids";
import { createToken } from "../../container/tokens";
import type { Product, ProductInput, Variant, VariantInput } from "./products.schema";

/** شكل الصف كما يرجع من جدول products. */
interface ProductRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  /** السعر بأصغر وحدة للعملة (BIGINT، يصل رقماً بفضل محوّل db/connection.ts). */
  price: number;
  category_id: string | null;
  is_active: boolean;
  image_url: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface VariantRow {
  id: string;
  product_id: string;
  sku: string;
  title: string;
  price: number | null;
  is_active: boolean;
  position: number;
  created_at: Date;
  updated_at: Date;
}

/** خيارات قائمة المنتجات. */
export interface ProductFilter {
  /** منتجات قسم واحد فقط. */
  categoryId?: string;
  /** بحث في الاسم (لا يهم حجم الحروف). */
  q?: string;
  sort?: "newest" | "price_asc" | "price_desc" | "name";
  /** المالك والموظفون يرون المنتجات غير النشطة (المخفية)، والعامة لا يرونها أبداً. */
  includeInactive?: boolean;
  limit: number;
  offset: number;
}

/** الترتيب لكل قيمة sort. نصوص ثابتة هنا، لا من الطلب، فوضعها في SQL آمن. */
const SORTS: Record<NonNullable<ProductFilter["sort"]>, string> = {
  newest: "created_at DESC, id",
  price_asc: "price ASC, id",
  price_desc: "price DESC, id",
  name: "name ASC, id",
};

/** مستودع المنتجات وأشكالها. */
export class ProductsRepository extends Repository<Product, ProductRow> {
  constructor(db: Queryable) {
    super(db, "products", "created_at DESC", true);
  }

  /** صف القاعدة إلى كائن الـ API (category_id يصبح categoryId، وهكذا). */
  protected toEntity(row: ProductRow): Product {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      price: row.price,
      categoryId: row.category_id,
      isActive: row.is_active,
      imageUrl: row.image_url,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toVariant(row: VariantRow): Variant {
    return {
      id: row.id,
      productId: row.product_id,
      sku: row.sku,
      title: row.title,
      price: row.price,
      isActive: row.is_active,
      position: row.position,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * صفحة من المنتجات حسب المرشحات، مع العدد الكلي. كل قيمة من الطلب تمر عبر $1 و $2...
   * البحث بـ ILIKE مع هروب % و _ في نص المستخدم، حتى لا يصبح "%" بحثاً عن كل شيء.
   */
  async listPage(filter: ProductFilter): Promise<ListPage<Product>> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (!filter.includeInactive) where.push("is_active = true");
    if (filter.categoryId !== undefined) {
      if (!isUuid(filter.categoryId)) return { items: [], total: 0 };
      values.push(filter.categoryId);
      where.push(`category_id = $${values.length}`);
    }
    if (filter.q) {
      values.push(`%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      where.push(`name ILIKE $${values.length}`);
    }
    const base = `SELECT * FROM products ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
    return this.page(base, values, SORTS[filter.sort ?? "newest"], filter.limit, filter.offset);
  }

  /** نفس listPage، العناصر فقط (للتوافق مع من يستخدم المستودع مباشرة). */
  async list(filter: ProductFilter): Promise<Product[]> {
    return (await this.listPage(filter)).items;
  }

  /** منتج برابطه المقروء (slug)، للروابط الجميلة في الموقع مثل /p/anc-headphones. */
  async findBySlug(slug: string): Promise<Product | null> {
    const result = await this.query("SELECT * FROM products WHERE slug = $1", [slug]);
    const row = result.rows[0];
    return row ? this.toEntity(row) : null;
  }

  /** يضيف منتجاً ويرجعه كاملاً (بقيمه الافتراضية من القاعدة، مثل id و created_at). */
  async create(input: ProductInput): Promise<Product> {
    const result = await this.query(
      `INSERT INTO products (name, slug, description, price, category_id, is_active, image_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        input.name,
        input.slug,
        input.description ?? null,
        input.price,
        input.categoryId ?? null,
        input.isActive ?? true,
        input.imageUrl ?? null,
      ]
    );
    return this.toEntity(result.rows[0] as ProductRow);
  }

  /** تعديل جزئي: اسم الحقل في الـ API (يساراً) واسم العمود في الجدول (يميناً). */
  update(id: string, input: Partial<ProductInput>, expectedVersion?: number): Promise<Product | null> {
    return this.updateColumns(
      id,
      {
        name: "name",
        slug: "slug",
        description: "description",
        price: "price",
        categoryId: "category_id",
        isActive: "is_active",
        imageUrl: "image_url",
      },
      input,
      expectedVersion
    );
  }

  /** أشكال منتج بترتيبها (position ثم الأقدم). */
  async listVariants(productId: string, options: { includeInactive?: boolean } = {}): Promise<Variant[]> {
    if (!isUuid(productId)) return [];
    const { rows } = await this.query<VariantRow>(
      `SELECT * FROM product_variants WHERE product_id = $1 ${options.includeInactive ? "" : "AND is_active"}
        ORDER BY position, created_at`,
      [productId]
    );
    return rows.map((r) => this.toVariant(r));
  }

  /** شكل واحد، بشرط أن يتبع هذا المنتج. */
  async findVariant(productId: string, variantId: string): Promise<Variant | null> {
    if (!isUuid(productId) || !isUuid(variantId)) return null;
    const { rows } = await this.query<VariantRow>("SELECT * FROM product_variants WHERE id = $1 AND product_id = $2", [
      variantId,
      productId,
    ]);
    return rows[0] ? this.toVariant(rows[0]) : null;
  }

  /** هل للمنتج أشكال نشطة؟ (إن نعم، لا يُشترى إلا بشكل محدد.) */
  async hasActiveVariants(productId: string): Promise<boolean> {
    if (!isUuid(productId)) return false;
    const { rows } = await this.query("SELECT 1 FROM product_variants WHERE product_id = $1 AND is_active LIMIT 1", [productId]);
    return rows.length > 0;
  }

  async createVariant(productId: string, input: VariantInput): Promise<Variant> {
    const { rows } = await this.query<VariantRow>(
      `INSERT INTO product_variants (product_id, sku, title, price, is_active, position)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [productId, input.sku, input.title, input.price ?? null, input.isActive ?? true, input.position ?? 0]
    );
    return this.toVariant(rows[0] as VariantRow);
  }

  async updateVariant(productId: string, variantId: string, input: Partial<VariantInput>): Promise<Variant | null> {
    if (!isUuid(productId) || !isUuid(variantId)) return null;
    const columns: Record<string, string> = { sku: "sku", title: "title", price: "price", isActive: "is_active", position: "position" };
    const sets: string[] = [];
    const values: unknown[] = [variantId, productId];
    for (const [field, column] of Object.entries(columns)) {
      const value = (input as Record<string, unknown>)[field];
      if (value === undefined) continue;
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    }
    sets.push("updated_at = now()");
    const { rows } = await this.query<VariantRow>(
      `UPDATE product_variants SET ${sets.join(", ")} WHERE id = $1 AND product_id = $2 RETURNING *`,
      values
    );
    return rows[0] ? this.toVariant(rows[0]) : null;
  }

  async deleteVariant(productId: string, variantId: string): Promise<boolean> {
    if (!isUuid(productId) || !isUuid(variantId)) return false;
    const result = await this.query("DELETE FROM product_variants WHERE id = $1 AND product_id = $2", [variantId, productId]);
    return (result.rowCount ?? 0) > 0;
  }
}

/** رمز المستودع في الحاوية. تطلبه وحدة السلة لتتأكد أن المنتج موجود ونشط قبل إضافته. */
export const PRODUCTS_REPOSITORY = createToken<ProductsRepository>("ProductsRepository");
