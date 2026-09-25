import type { Migration } from "../../db/migrations";
import type { Infer, Schema } from "../../engine/validation";

export const customersMigrations: Migration[] = [
  {
    // Registered customers only - guests never get a row here; their contact
    // details live on the order itself.
    id: "0400_create_customers",
    up: `
      CREATE TABLE customers (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email         TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        name          TEXT NOT NULL,
        phone         TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX customers_email_key ON customers (lower(email));
    `,
  },
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PHONE = /^\+?[0-9][0-9 ()-]{5,29}$/;

export const registerSchema = {
  email: { type: "string", maxLength: 254, pattern: EMAIL },
  // Upper bound stops someone from making the server hash a megabyte-long "password".
  password: { type: "string", minLength: 8, maxLength: 128 },
  name: { type: "string", minLength: 1, maxLength: 120 },
  phone: { type: "string", maxLength: 30, pattern: PHONE, optional: true },
} as const satisfies Schema;

export const loginSchema = {
  email: { type: "string", maxLength: 254 },
  password: { type: "string", maxLength: 128 },
} as const satisfies Schema;

export const profileSchema = {
  name: { type: "string", minLength: 1, maxLength: 120 },
  phone: { type: "string", maxLength: 30, pattern: PHONE },
} as const satisfies Schema;

export type RegisterInput = Infer<typeof registerSchema>;
export type LoginInput = Infer<typeof loginSchema>;
export type ProfileInput = Infer<typeof profileSchema>;

/** Never contains the password hash - this is what the API returns. */
export interface Customer {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
