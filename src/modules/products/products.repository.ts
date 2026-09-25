import { Repository, type Queryable } from "../../db/repository";
import { isUuid } from "../../db/ids";
import { createToken } from "../../container/tokens";
import type { Product, ProductInput } from "./products.schema";

interface ProductRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  price: number;
  category_id: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ProductFilter {
  categoryId?: string;
  /** Owner views include inactive (hidden) products; the public never sees them. */
  includeInactive?: boolean;
  limit: number;
  offset: number;
}

export class ProductsRepository extends Repository<Product, ProductRow> {
  constructor(db: Queryable) {
    super(db, "products");
  }

  protected toEntity(row: ProductRow): Product {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      price: row.price,
      categoryId: row.category_id,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async list(filter: ProductFilter): Promise<Product[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (!filter.includeInactive) where.push("is_active = true");
    if (filter.categoryId !== undefined) {
      if (!isUuid(filter.categoryId)) return [];
      values.push(filter.categoryId);
      where.push(`category_id = $${values.length}`);
    }
    values.push(filter.limit, filter.offset);
    const result = await this.query(
      `SELECT * FROM products ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return result.rows.map((row) => this.toEntity(row));
  }

  async create(input: ProductInput): Promise<Product> {
    const result = await this.query(
      `INSERT INTO products (name, slug, description, price, category_id, is_active)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        input.name,
        input.slug,
        input.description ?? null,
        input.price,
        input.categoryId ?? null,
        input.isActive ?? true,
      ]
    );
    return this.toEntity(result.rows[0] as ProductRow);
  }

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
      },
      input
    );
  }
}

export const PRODUCTS_REPOSITORY = createToken<ProductsRepository>("ProductsRepository");
