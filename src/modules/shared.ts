import { NotFoundError, PreconditionFailedError } from "../engine/errors";
import type { ListPage } from "../db/repository";
import type { AppRequest } from "../engine/http/request";
import type { AppResponse } from "../engine/http/response";
import type { Schema } from "../engine/validation";

/**
 * أدوات صغيرة تتشاركها الوحدات.
 */

/** حقول الترقيم في الاستعلام، تُدمج في query schema لأي مسار قائمة. */
export const PAGINATION_QUERY = {
  limit: { type: "number", integer: true, min: 1, max: 100, optional: true, description: "Page size (default 50)" },
  offset: { type: "number", integer: true, min: 0, optional: true, description: "Rows to skip (default 0)" },
} as const satisfies Schema;

/** متغير المسار :id. نص بلا قيد UUID عمداً: الرقم غير الصالح يعطي 404 (غير موجود) كما كان دائماً. */
export const ID_PARAMS = { id: { type: "string", maxLength: 100 } } as const satisfies Schema;

/**
 * يرسل صفحة قائمة: العناصر في الجسم (مصفوفة، كما كان الـ API دائماً)، والعدد الكلي في ترويسة
 * X-Total-Count، فيبني الموقع أزرار الصفحات دون أن يتغير شكل الرد.
 */
export function sendPage<T>(res: AppResponse, page: ListPage<T>): void {
  res.setHeader("X-Total-Count", String(page.total));
  res.json(page.items);
}

/**
 * يحوّل null إلى 404. مثال: res.json(found(await repo.findById(id), "Product"))
 * يرد بالمنتج إن وُجد، أو يرمي NotFoundError("Product not found").
 */
export function found<T>(entity: T | null, what: string): T {
  if (entity === null) throw new NotFoundError(`${what} not found`);
  return entity;
}

/** صيغة slug: حروف صغيرة وأرقام مفصولة بشرطات، مثل "phone-cases". */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * ETag من رقم النسخة: "<version>". الموقع يقرؤه من GET، ويعيده في If-Match مع PATCH أو DELETE.
 */
export function etag(version: number): string {
  return `"${version}"`;
}

/**
 * يقرأ If-Match ويرجع رقم النسخة المتوقعة، أو undefined إن لم تُرسل الترويسة أو كانت "*" (أي نسخة).
 * القيمة المعطوبة تعطي 412، لأن العميل طلب شرطاً لا نستطيع التحقق منه.
 */
export function expectedVersion(req: AppRequest): number | undefined {
  const header = req.headers["if-match"];
  if (header === undefined || header.trim() === "*") return undefined;
  const match = /^\s*(?:W\/)?"(\d+)"\s*$/.exec(header);
  if (!match) throw new PreconditionFailedError("If-Match must be an ETag like \"3\"");
  return Number(match[1]);
}

/** من نفّذ العملية، كما يُحفظ في سجل الطلب الزمني. */
export interface Actor {
  type: "owner" | "staff" | "customer" | "guest" | "system";
  id: string | null;
}

/** الفاعل من الطلب (المالك، أو موظف، أو زبون، أو ضيف). */
export function actorOf(req: AppRequest): Actor {
  const auth = req.auth;
  if (!auth) return { type: "guest", id: null };
  const type = auth.principal ?? (auth.role === "owner" ? "owner" : "customer");
  return { type, id: auth.userId ?? null };
}

/** الفاعل في المهام التلقائية (مثل إلغاء طلب لم يُدفع في مهلته). */
export const SYSTEM_ACTOR: Actor = { type: "system", id: null };
