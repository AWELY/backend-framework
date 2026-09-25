import { Repository, type Queryable } from "../../db/repository";
import { createToken } from "../../container/tokens";
import type { Customer, ProfileInput } from "./customers.schema";

interface CustomerRow {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  phone: string | null;
  created_at: Date;
  updated_at: Date;
}

export class CustomersRepository extends Repository<Customer, CustomerRow> {
  constructor(db: Queryable) {
    super(db, "customers");
  }

  /** Drops password_hash: it must never leave the repository through the normal entity. */
  protected toEntity(row: CustomerRow): Customer {
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      phone: row.phone,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async create(input: { email: string; passwordHash: string; name: string; phone?: string }): Promise<Customer> {
    const result = await this.query(
      "INSERT INTO customers (email, password_hash, name, phone) VALUES ($1, $2, $3, $4) RETURNING *",
      [input.email, input.passwordHash, input.name, input.phone ?? null]
    );
    return this.toEntity(result.rows[0] as CustomerRow);
  }

  /** The only method that returns the hash - used by login, nowhere else. */
  async findCredentials(email: string): Promise<{ customer: Customer; passwordHash: string } | null> {
    const result = await this.query("SELECT * FROM customers WHERE lower(email) = lower($1)", [email]);
    const row = result.rows[0];
    return row ? { customer: this.toEntity(row), passwordHash: row.password_hash } : null;
  }

  updateProfile(id: string, input: Partial<ProfileInput>): Promise<Customer | null> {
    return this.updateColumns(id, { name: "name", phone: "phone" }, input);
  }
}

export const CUSTOMERS_REPOSITORY = createToken<CustomersRepository>("CustomersRepository");
