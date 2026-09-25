import type { Migration } from "../../db/migrations";
import type { Infer, Schema } from "../../engine/validation";
import { SLUG_PATTERN } from "../shared";

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
];

export const categoryInputSchema = {
  name: { type: "string", minLength: 1, maxLength: 120 },
  slug: { type: "string", minLength: 1, maxLength: 120, pattern: SLUG_PATTERN },
  description: { type: "string", maxLength: 2000, optional: true },
} as const satisfies Schema;

export type CategoryInput = Infer<typeof categoryInputSchema>;

export interface Category {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}
