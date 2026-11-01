import { NotFoundError } from "../engine/errors";
import type { ListOptions } from "../db/repository";

/**
 * يقرأ الترقيم من الاستعلام (?limit=&offset=) بحدود آمنة، فلا يستطيع عميل طلب مليون صف دفعة واحدة.
 *   - limit: من 1 إلى 100، والافتراضي 50.
 *   - offset: 0 أو أكثر، والافتراضي 0.
 * أي قيمة خارج الحدود أو غير صحيحة (مثل "abc" أو 2.5) ترجع إلى القيمة الافتراضية بدل الخطأ.
 * مثال: "/products?limit=20&offset=40" يعطي الصفحة الثالثة من 20 منتجاً.
 */
export function parsePagination(query: URLSearchParams): Required<ListOptions> {
  const limit = Number(query.get("limit") ?? 50);
  const offset = Number(query.get("offset") ?? 0);
  return {
    limit: Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 50,
    offset: Number.isInteger(offset) && offset >= 0 ? offset : 0,
  };
}

/**
 * يرجع الكائن إن وُجد، وإلا يرمي 404 باسم ما لم يوجد.
 * مثال: found(await repo().findById(id), "Product") ترمي "Product not found" إن كانت النتيجة null.
 * تختصر في كل مسار ثلاثة أسطر: if (!x) throw new NotFoundError(...)
 */
export function found<T>(entity: T | null, what: string): T {
  if (entity === null) throw new NotFoundError(`${what} not found`);
  return entity;
}

/**
 * شكل الـ slug (الاسم المختصر في الروابط): حروف إنجليزية صغيرة وأرقام، تفصلها شرطات مفردة.
 * مقبول: "phone-chargers" و "usb-c-cable-2m". مرفوض: "Phone" و "a--b" و "-x".
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
