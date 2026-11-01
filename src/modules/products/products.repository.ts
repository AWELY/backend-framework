import { Repository, type Queryable } from "../../db/repository";
import { isUuid } from "../../db/ids";
import { createToken } from "../../container/tokens";
import type { Product, ProductInput } from "./products.schema";

/** شكل الصف كما يرجع من جدول products. */
interface ProductRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  /** السعر بالدرهم (رقم صحيح). */
  price: number;
  category_id: string | null;
  is_active: boolean;
  image_url: string | null;
  created_at: Date;
  updated_at: Date;
}

/** خيارات قائمة المنتجات. */
export interface ProductFilter {
  /** منتجات قسم واحد فقط. */
  categoryId?: string;
  /** المالك يرى المنتجات غير النشطة (المخفية)، والعامة لا يرونها أبداً. */
  includeInactive?: boolean;
  limit: number;
  offset: number;
}

/** مستودع المنتجات. */
export class ProductsRepository extends Repository<Product, ProductRow> {
  constructor(db: Queryable) {
    // الترتيب الافتراضي من الصنف الأب: الأحدث أولاً.
    super(db, "products");
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
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * قائمة المنتجات مع التصفية والترقيم. نبني شرط WHERE من أجزاء حسب الخيارات:
   *
   * مثال: زائر يطلب قسماً، فيكون where = ["is_active = true", "category_id = $1"]
   * و values = [categoryId, limit, offset]، والاستعلام:
   *   SELECT * FROM products WHERE is_active = true AND category_id = $1
   *   ORDER BY created_at DESC LIMIT $2 OFFSET $3
   *
   * أجزاء الشرط نصوص ثابتة من كتابتنا، وكل قيمة تمر عبر $n، فلا مجال لـ SQL Injection.
   */
  async list(filter: ProductFilter): Promise<Product[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (!filter.includeInactive) where.push("is_active = true");
    if (filter.categoryId !== undefined) {
      // رقم قسم ليس UUID لا يطابق أي قسم: قائمة فارغة مباشرة، دون استعلام.
      if (!isUuid(filter.categoryId)) return [];
      values.push(filter.categoryId);
      where.push(`category_id = $${values.length}`);
    }
    // limit و offset آخر قيمتين، فرقماهما values.length - 1 و values.length.
    values.push(filter.limit, filter.offset);
    const result = await this.query(
      `SELECT * FROM products ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return result.rows.map((row) => this.toEntity(row));
  }

  /**
   * ينشئ منتجاً. الحقول الاختيارية التي لم تُرسل تأخذ قيمة افتراضية: null للوصف والقسم
   * والصورة، و true لـ isActive (المنتج الجديد ظاهر).
   * categoryId غير موجود في جدول الأقسام يجعل القاعدة ترفض (المفتاح الأجنبي)، فيصبح الرد 400.
   */
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
  update(id: string, input: Partial<ProductInput>): Promise<Product | null> {
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
      input
    );
  }
}

/** رمز المستودع في الحاوية. تطلبه وحدة السلة لتتأكد أن المنتج موجود ونشط قبل إضافته. */
export const PRODUCTS_REPOSITORY = createToken<ProductsRepository>("ProductsRepository");
