import { Repository, type Queryable } from "../../db/repository";
import { createToken } from "../../container/tokens";
import type { Category, CategoryInput } from "./categories.schema";

interface CategoryRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
}

export class CategoriesRepository extends Repository<Category, CategoryRow> {
  constructor(db: Queryable) {
    super(db, "categories", "name ASC");
  }

  protected toEntity(row: CategoryRow): Category {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async create(input: CategoryInput): Promise<Category> {
    const result = await this.query(
      "INSERT INTO categories (name, slug, description) VALUES ($1, $2, $3) RETURNING *",
      [input.name, input.slug, input.description ?? null]
    );
    return this.toEntity(result.rows[0] as CategoryRow);
  }

  update(id: string, input: Partial<CategoryInput>): Promise<Category | null> {
    return this.updateColumns(id, { name: "name", slug: "slug", description: "description" }, input);
  }
}

export const CATEGORIES_REPOSITORY = createToken<CategoriesRepository>("CategoriesRepository");
