import { createHash } from "node:crypto";
import type { AppRequest } from "../engine/http/request";
import type { AppResponse } from "../engine/http/response";
import type { NextFunction } from "../engine/router";
import { ConflictError, ErrorCodes, ValidationError } from "../engine/errors";
import { withMeta } from "../engine/route-meta";

/** نتيجة حجز مفتاح: جديد (نفّذ)، أو رد محفوظ (أعده)، أو قيد التنفيذ، أو مستخدم لطلب مختلف. */
export type IdempotencyBegin =
  | { state: "new" }
  | { state: "replay"; status: number; body: unknown }
  | { state: "in_progress" }
  | { state: "mismatch" };

/** أين تُحفظ المفاتيح والردود. ينفّذه src/runtime/idempotency.ts فوق PostgreSQL. */
export interface IdempotencyStore {
  begin(scope: string, key: string, requestHash: string): Promise<IdempotencyBegin>;
  complete(scope: string, key: string, status: number, body: unknown): Promise<void>;
  release(scope: string, key: string): Promise<void>;
}

const KEY_PATTERN = /^[A-Za-z0-9_\-:.]{1,255}$/;

/**
 * ترويسة Idempotency-Key: "نفّذ هذا الطلب مرة واحدة فقط، مهما أرسلته".
 *
 * المشكلة: المشتري يضغط "تأكيد الطلب"، فيصل الطلب ويُنشأ، لكن الشبكة تنقطع قبل وصول الرد.
 * الموقع لا يعرف هل نجح، فيعيد الإرسال. بدون هذه الترويسة: إما طلب مكرر، أو رد 409 محيّر
 * ("السلة اشتُريت من قبل") بدل الطلب نفسه.
 *
 * الحل: الموقع يولّد مفتاحاً عشوائياً مرة لكل محاولة شراء (crypto.randomUUID()) ويرسله في كل إعادة:
 *   - أول طلب بالمفتاح: يُنفَّذ، ويُحفظ رده (الرمز والجسم).
 *   - إعادة بنفس المفتاح ونفس الجسم: يُرجَع الرد المحفوظ نفسه، مع ترويسة Idempotency-Replayed: true.
 *   - إعادة والطلب الأول ما زال يعمل: 409 IDEMPOTENCY_IN_PROGRESS (أعد المحاولة بعد قليل).
 *   - نفس المفتاح بجسم مختلف: 409 IDEMPOTENCY_KEY_REUSED (خطأ في الموقع).
 *
 * ما يُحفظ: الردود الناجحة وأخطاء العميل (4xx)، فالإعادة ترى نفس النتيجة. أخطاء الخادم (5xx)
 * و 429 لا تُحفظ، فيُحرَّر المفتاح وتستطيع الإعادة أن تنجح.
 *
 * الرد يُحفظ قبل إرساله، لا بعده: لو أُرسل أولاً لاستطاع عميل سريع أن يعيد الطلب قبل الحفظ.
 * المفتاح مقصور على المرسل (scope): مفتاح زبون لا يصطدم بمفتاح زبون آخر.
 * الترويسة اختيارية: الطلب بدونها يعمل كما كان دائماً.
 */
export function idempotency(store: IdempotencyStore) {
  const middleware = async function idempotencyMiddleware(req: AppRequest, res: AppResponse, next: NextFunction): Promise<void> {
    const key = req.headers["idempotency-key"];
    if (key === undefined) return next();
    if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
      throw new ValidationError("Invalid Idempotency-Key header", [
        { field: "Idempotency-Key", message: "must be 1-255 characters: letters, digits, - _ : ." },
      ]);
    }
    const actor = req.auth ? `${req.auth.principal ?? req.auth.role}:${req.auth.userId ?? "-"}` : "guest";
    // المسار الحقيقي (وفيه رقم الطلب)، لا النمط "/orders/:id/refunds": نفس المفتاح على طلبين مختلفين
    // عمليتان مختلفتان، ولا يجب أن يعيد الثاني رد الأول.
    const scope = `${req.method} ${(req.url ?? "").split("?")[0]}|${actor}`;
    const requestHash = createHash("sha256").update(req.rawBody ?? "").digest("hex");

    const begun = await store.begin(scope, key, requestHash);
    if (begun.state === "replay") {
      res.setHeader("Idempotency-Replayed", "true");
      res.status(begun.status).json(begun.body);
      return;
    }
    if (begun.state === "in_progress") {
      throw new ConflictError("A request with this Idempotency-Key is still being processed", undefined, ErrorCodes.IDEMPOTENCY_IN_PROGRESS);
    }
    if (begun.state === "mismatch") {
      throw new ConflictError(
        "This Idempotency-Key was already used with a different request body",
        undefined,
        ErrorCodes.IDEMPOTENCY_KEY_REUSED
      );
    }

    // مفتاح جديد: نلتقط الرد قبل إرساله، نحفظه (أو نحرر المفتاح)، ثم نرسله.
    let settled = false;
    const send = res.json.bind(res);
    res.json = (data: unknown): void => {
      settled = true;
      const status = res.statusCode;
      const persist = status < 500 && status !== 429;
      const write = persist ? store.complete(scope, key, status, data) : store.release(scope, key);
      write
        .catch((err: unknown) => req.log.error("Idempotency store failed", { message: err instanceof Error ? err.message : String(err) }))
        .finally(() => send(data));
    };
    // انقطع الاتصال قبل أي رد: نحرر المفتاح حتى لا يبقى عالقاً.
    res.on("close", () => {
      if (!settled) store.release(scope, key).catch(() => undefined);
    });
    next();
  };
  return withMeta(middleware, { idempotent: true });
}
