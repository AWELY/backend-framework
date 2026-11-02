import type { CommercePlugin } from "../modules/types";
import type { Schema } from "../engine/validation";
import { withInput } from "../middleware/validate";
import { requirePermission } from "../middleware/auth";
import { ConflictError, ErrorCodes, NotFoundError, ValidationError } from "../engine/errors";
import { translateDbError } from "../db/errors";
import { withTransaction } from "../db/transaction";
import { PAGINATION_QUERY, sendPage, found } from "../modules/shared";

/**
 * إضافة الكوبونات: خصم بنسبة (10%) أو بمبلغ ثابت (5 دنانير)، بشروط اختيارية: حد أدنى للمشتريات،
 * وعدد مرات استخدام أقصى، وتاريخ انتهاء.
 *
 * مبنية فقط على نقاط التوسعة العامة، مثل أي إضافة خارجية:
 *   - جداولها (migrations)،
 *   - مسارات إدارة الكوبونات (router + requirePermission)،
 *   - معدّل سعر (PriceAdjuster) يحسب الخصم عند التسعير والشراء،
 *   - مستمعان: order.created يسجّل الاستخدام، و order.statusChanged (إلغاء) يعيده.
 *
 * التسجيل "مرة واحدة على الأقل" آمن: coupon_redemptions مفتاحها رقم الطلب، فالحدث المكرر لا يُعدّ مرتين.
 * حد الاستخدام مرن قليلاً: طلبان متزامنان على آخر استخدام قد يمران معاً (العدّ بعد الشراء).
 * لحد صارم، احجز الاستخدام داخل معاملة الشراء نفسها.
 *
 * الصلاحيات: coupons:write للإدارة، و coupons:read للقراءة (المدير والمشرف في DEFAULT_ROLES).
 */

/** رمز الكوبون: حروف كبيرة وأرقام وشرطات، من 3 إلى 40. الإدخال يُحوَّل لحروف كبيرة. */
const CODE_PATTERN = /^[A-Z0-9_-]{3,40}$/;

const couponInput = {
  code: { type: "string", pattern: CODE_PATTERN },
  kind: { type: "string", oneOf: ["percent", "fixed"] },
  value: { type: "number", integer: true, min: 1, max: Number.MAX_SAFE_INTEGER, description: "Percent (1-100) or amount in minor units" },
  minSubtotal: { type: "number", integer: true, min: 0, optional: true },
  maxRedemptions: { type: "number", integer: true, min: 1, optional: true, nullable: true },
  expiresAt: { type: "string", pattern: /^\d{4}-\d{2}-\d{2}T/, optional: true, nullable: true, description: "ISO date-time" },
  isActive: { type: "boolean", optional: true },
} as const satisfies Schema;

const couponUpdate = {
  value: couponInput.value,
  minSubtotal: couponInput.minSubtotal,
  maxRedemptions: couponInput.maxRedemptions,
  expiresAt: couponInput.expiresAt,
  isActive: couponInput.isActive,
} as const satisfies Schema;

interface CouponRow {
  code: string;
  kind: "percent" | "fixed";
  value: number;
  min_subtotal: number;
  max_redemptions: number | null;
  redeemed_count: number;
  expires_at: Date | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

/** الكوبون كما يرد في الـ API. */
export interface Coupon {
  code: string;
  kind: "percent" | "fixed";
  value: number;
  minSubtotal: number;
  maxRedemptions: number | null;
  redeemedCount: number;
  expiresAt: Date | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const toCoupon = (r: CouponRow): Coupon => ({
  code: r.code,
  kind: r.kind,
  value: r.value,
  minSubtotal: r.min_subtotal,
  maxRedemptions: r.max_redemptions,
  redeemedCount: r.redeemed_count,
  expiresAt: r.expires_at,
  isActive: r.is_active,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** مصدر بنود الخصم في الطلب، يقرؤه المستمع ليعرف أي كوبون استُخدم. */
const SOURCE = "coupons";

/** تاريخ الانتهاء يجب أن يكون تاريخاً حقيقياً (النمط وحده يقبل "2026-13-40T..."). */
function checkExpiry(expiresAt: string | null | undefined, issues: Array<{ field: string; message: string }>): void {
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) issues.push({ field: "expiresAt", message: "has an invalid format" });
}

export function coupons(): CommercePlugin {
  return {
    name: "coupons",
    version: "1.0.0",
    dependsOn: ["orders"],
    migrations: [
      {
        id: "1100_coupons",
        up: `
          CREATE TABLE coupons (
            code            TEXT PRIMARY KEY,
            kind            TEXT NOT NULL CHECK (kind IN ('percent', 'fixed')),
            value           BIGINT NOT NULL CHECK (value > 0),
            min_subtotal    BIGINT NOT NULL DEFAULT 0 CHECK (min_subtotal >= 0),
            max_redemptions INTEGER CHECK (max_redemptions > 0),
            redeemed_count  INTEGER NOT NULL DEFAULT 0,
            expires_at      TIMESTAMPTZ,
            is_active       BOOLEAN NOT NULL DEFAULT true,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK (kind <> 'percent' OR value <= 100)
          );
          CREATE TABLE coupon_redemptions (
            order_id   UUID PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
            code       TEXT NOT NULL REFERENCES coupons(code) ON DELETE CASCADE,
            amount     BIGINT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
        `,
      },
    ],

    setup({ router, pool, accessControl, authenticate, extensions, logger }) {
      const canRead = requirePermission(accessControl, "coupons:read");
      const canWrite = requirePermission(accessControl, "coupons:write");
      const codeParams = { code: { type: "string", maxLength: 40 } } as const;

      // معدّل السعر: يتحقق من الكوبون ويحسب الخصم. الخطأ برسالة مفهومة للمشتري ورمز INVALID_COUPON.
      extensions.addPriceAdjuster({
        id: SOURCE,
        async adjust({ couponCode, subtotal }) {
          if (!couponCode) return [];
          const code = couponCode.trim().toUpperCase();
          const invalid = (message: string) =>
            new ValidationError(message, [{ field: "couponCode", message }], "INVALID_COUPON");
          const { rows } = await pool.query<CouponRow>("SELECT * FROM coupons WHERE code = $1", [code]);
          const c = rows[0];
          if (!c || !c.is_active) throw invalid("This coupon does not exist");
          if (c.expires_at && c.expires_at.getTime() <= Date.now()) throw invalid("This coupon has expired");
          if (c.max_redemptions !== null && c.redeemed_count >= c.max_redemptions) throw invalid("This coupon has been used up");
          if (subtotal < c.min_subtotal) throw invalid(`This coupon needs a subtotal of at least ${c.min_subtotal}`);
          const amount = c.kind === "percent" ? Math.floor((subtotal * c.value) / 100) : Math.min(c.value, subtotal);
          if (amount === 0) return [];
          const label = c.kind === "percent" ? `Coupon ${code} (${c.value}%)` : `Coupon ${code}`;
          return [{ code: `COUPON:${code}`, label, type: "discount", amount }];
        },
      });

      // الاستخدام يُعدّ بعد الشراء. مفتاح coupon_redemptions رقم الطلب: الحدث المكرر لا يُعدّ مرتين.
      extensions.on("order.created", async ({ order }) => {
        const line = order.adjustments.find((a) => a.source === SOURCE);
        if (!line) return;
        const code = line.code.replace(/^COUPON:/, "");
        await withTransaction(pool, async (client) => {
          const inserted = await client.query(
            "INSERT INTO coupon_redemptions (order_id, code, amount) VALUES ($1, $2, $3) ON CONFLICT (order_id) DO NOTHING RETURNING order_id",
            [order.id, code, line.amount]
          );
          if (inserted.rows.length > 0) {
            await client.query("UPDATE coupons SET redeemed_count = redeemed_count + 1, updated_at = now() WHERE code = $1", [code]);
          }
        });
      });

      // طلب أُلغي: يعود استخدام الكوبون (مرة واحدة فقط، لأن الصف يُحذف).
      extensions.on("order.statusChanged", async ({ order }) => {
        if (order.status !== "cancelled") return;
        await withTransaction(pool, async (client) => {
          const removed = await client.query<{ code: string }>("DELETE FROM coupon_redemptions WHERE order_id = $1 RETURNING code", [order.id]);
          const code = removed.rows[0]?.code;
          if (code) await client.query("UPDATE coupons SET redeemed_count = GREATEST(0, redeemed_count - 1), updated_at = now() WHERE code = $1", [code]);
        });
        logger.debug("Coupon redemption released for a cancelled order", { orderId: order.id });
      });

      router.get(
        "/coupons",
        authenticate,
        canRead,
        withInput({ query: PAGINATION_QUERY, summary: "List coupons" }, async (_req, res, { query }) => {
          const { rows } = await pool.query<CouponRow & { total: number }>(
            "SELECT *, COUNT(*) OVER() AS total FROM coupons ORDER BY created_at DESC LIMIT $1 OFFSET $2",
            [query.limit ?? 50, query.offset ?? 0]
          );
          sendPage(res, { items: rows.map(toCoupon), total: rows[0]?.total ?? 0 });
        })
      );

      router.post(
        "/coupons",
        authenticate,
        canWrite,
        withInput({ body: { ...couponInput, code: { type: "string", minLength: 3, maxLength: 40 } }, summary: "Create a coupon", successStatus: 201 }, async (_req, res, { body }) => {
          const code = body.code.trim().toUpperCase();
          const issues: Array<{ field: string; message: string }> = [];
          if (!CODE_PATTERN.test(code)) issues.push({ field: "code", message: "has an invalid format" });
          if (body.kind === "percent" && body.value > 100) issues.push({ field: "value", message: "must be <= 100 for a percent coupon" });
          checkExpiry(body.expiresAt, issues);
          if (issues.length) throw new ValidationError("Validation failed", issues);
          const { rows } = await pool.query<CouponRow>(
            `INSERT INTO coupons (code, kind, value, min_subtotal, max_redemptions, expires_at, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [code, body.kind, body.value, body.minSubtotal ?? 0, body.maxRedemptions ?? null, body.expiresAt ?? null, body.isActive ?? true]
          ).catch((err: { code?: string }) => {
            // نفس رمز الإطار لأي قيمة مكررة: 409 DUPLICATE_VALUE، مع اسم الحقل في details.
            if (err.code === "23505") throw new ConflictError("A coupon with this code already exists", [{ field: "code", message: "already exists" }], ErrorCodes.DUPLICATE_VALUE);
            throw translateDbError(err);
          });
          res.status(201).json(toCoupon(rows[0] as CouponRow));
        })
      );

      router.patch(
        "/coupons/:code",
        authenticate,
        canWrite,
        withInput({ params: codeParams, body: couponUpdate, partial: true, summary: "Update a coupon" }, async (_req, res, { params, body }) => {
          const columns: Record<string, string> = {
            value: "value",
            minSubtotal: "min_subtotal",
            maxRedemptions: "max_redemptions",
            expiresAt: "expires_at",
            isActive: "is_active",
          };
          const code = params.code.toUpperCase();
          const current = await pool.query<{ kind: string }>("SELECT kind FROM coupons WHERE code = $1", [code]);
          if (!current.rows[0]) throw new NotFoundError("Coupon not found");
          const issues: Array<{ field: string; message: string }> = [];
          if (current.rows[0].kind === "percent" && body.value !== undefined && body.value > 100) {
            issues.push({ field: "value", message: "must be <= 100 for a percent coupon" });
          }
          checkExpiry(body.expiresAt, issues);
          if (issues.length) throw new ValidationError("Validation failed", issues);
          const sets: string[] = ["updated_at = now()"];
          const values: unknown[] = [code];
          for (const [field, column] of Object.entries(columns)) {
            const value = (body as Record<string, unknown>)[field];
            if (value === undefined) continue;
            values.push(value);
            sets.push(`${column} = $${values.length}`);
          }
          const { rows } = await pool
            .query<CouponRow>(`UPDATE coupons SET ${sets.join(", ")} WHERE code = $1 RETURNING *`, values)
            .catch((err: unknown) => {
              throw translateDbError(err);
            });
          res.json(toCoupon(found(rows[0] ?? null, "Coupon")));
        })
      );

      router.delete(
        "/coupons/:code",
        authenticate,
        canWrite,
        withInput({ params: codeParams, summary: "Delete a coupon", successStatus: 204 }, async (_req, res, { params }) => {
          const result = await pool.query("DELETE FROM coupons WHERE code = $1", [params.code.toUpperCase()]);
          if (result.rowCount === 0) throw new NotFoundError("Coupon not found");
          res.status(204).end();
        })
      );
    },
  };
}
