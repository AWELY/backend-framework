import { Repository, type ListPage, type Queryable } from "../../db/repository";
import { isUuid } from "../../db/ids";
import { createToken } from "../../container/tokens";
import type { Staff } from "./staff.schema";

interface StaffRow {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  phone: string | null;
  role: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

/** مستودع الموظفين. */
export class StaffRepository extends Repository<Staff, StaffRow> {
  constructor(db: Queryable) {
    super(db, "staff", "name ASC");
  }

  protected toEntity(row: StaffRow): Staff {
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      phone: row.phone,
      role: row.role,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async create(input: { email: string; passwordHash: string; name: string; phone?: string | null; role: string }): Promise<Staff> {
    const { rows } = await this.query(
      "INSERT INTO staff (email, password_hash, name, phone, role) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [input.email, input.passwordHash, input.name, input.phone ?? null, input.role]
    );
    return this.toEntity(rows[0] as StaffRow);
  }

  async findCredentials(email: string): Promise<{ staff: Staff; passwordHash: string } | null> {
    const { rows } = await this.query("SELECT * FROM staff WHERE lower(email) = lower($1)", [email]);
    const row = rows[0];
    return row ? { staff: this.toEntity(row), passwordHash: row.password_hash } : null;
  }

  async passwordHashOf(id: string): Promise<string | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.query<{ password_hash: string }>("SELECT password_hash FROM staff WHERE id = $1", [id]);
    return rows[0]?.password_hash ?? null;
  }

  /** الدور الحالي لموظف نشط، أو null إن كان موقوفاً أو غير موجود (للجلسات). */
  async activeRole(id: string): Promise<string | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.query<{ role: string }>("SELECT role FROM staff WHERE id = $1 AND is_active", [id]);
    return rows[0]?.role ?? null;
  }

  update(
    id: string,
    input: { name?: string; phone?: string | null; role?: string; isActive?: boolean; passwordHash?: string }
  ): Promise<Staff | null> {
    return this.updateColumns(
      id,
      { name: "name", phone: "phone", role: "role", isActive: "is_active", passwordHash: "password_hash" },
      input
    );
  }

  async search(filter: { role?: string; q?: string; limit: number; offset: number }): Promise<ListPage<Staff>> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filter.role) {
      values.push(filter.role);
      where.push(`role = $${values.length}`);
    }
    if (filter.q) {
      values.push(`%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      where.push(`(email ILIKE $${values.length} OR name ILIKE $${values.length})`);
    }
    return this.page(`SELECT * FROM staff ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`, values, "name ASC", filter.limit, filter.offset);
  }
}

export const STAFF_REPOSITORY = createToken<StaffRepository>("StaffRepository");
