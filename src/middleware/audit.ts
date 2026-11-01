import type { AppRequest } from "../engine/http/request";
import type { AppResponse } from "../engine/http/response";
import type { NextFunction } from "../engine/router";
import { redactSensitive } from "../engine/logger";

/** سطر واحد في سجل التدقيق. */
export interface AuditEntry {
  /** "owner" أو "staff" (أو أي نوع آخر تسجله إضافة). */
  actorType: string;
  actorId?: string | null;
  actorRole: string;
  /** العملية، مثل "PATCH /products/:id" أو "staff.login". */
  action: string;
  route?: string | null;
  path: string;
  params?: Record<string, string>;
  statusCode: number;
  requestId?: string | null;
  ip?: string | null;
  body?: unknown;
}

/** أين يُكتب السجل. ينفّذه src/runtime/audit-log.ts فوق PostgreSQL. */
export interface AuditSink {
  record(entry: AuditEntry): Promise<void>;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** أقصى حجم لجسم الطلب المحفوظ في السجل؛ الأكبر يُحفظ مكانه ملاحظة فقط. */
const MAX_BODY_CHARS = 8 * 1024;

/**
 * سجل تدقيق تلقائي: كل طلب كتابة (POST و PUT و PATCH و DELETE) من المالك أو موظف يُسجَّل بعد
 * انتهائه: من (النوع والرقم والدور)، وماذا (المسار المسجّل ومتغيراته والجسم)، ومتى، ومن أين (IP)،
 * وبأي نتيجة (رمز الحالة، فالمحاولات المرفوضة تظهر أيضاً)، ورقم الطلب لربطه بسطر السجل.
 *
 * لماذا تلقائي وليس سطراً في كل مسار؟ لأن المسار الذي ينسى أحد أن يسجّله هو بالضبط الذي سنحتاجه
 * يوماً. هنا لا يمكن النسيان، ويشمل مسارات الإضافات أيضاً.
 * الحقول الحساسة في الجسم (كلمات المرور والتوكنات) تُحجب قبل الحفظ. طلبات الزبائن لا تُسجَّل هنا
 * (ليست عمليات إدارية، وتسجيلها يملأ الجدول ببيانات شخصية دون فائدة).
 *
 * يعمل كمعالج عام (قبل المصادقة)، ويقرأ req.auth عند انتهاء الرد، وقتها تكون المصادقة قد عملت.
 * الكتابة لا تؤخر الرد (بعد finish)، وفشلها يُسجَّل خطأً ولا يكسر الطلب.
 */
export function auditTrail(sink: AuditSink, options: { clientIp: (req: AppRequest) => string }) {
  return function auditTrailMiddleware(req: AppRequest, res: AppResponse, next: NextFunction): void {
    if (SAFE_METHODS.has(req.method ?? "GET")) return next();
    res.on("finish", () => {
      const auth = req.auth;
      if (!auth || auth.principal === "customer" || (auth.principal === undefined && auth.role === "customer")) return;
      let body: unknown = req.body === undefined ? undefined : redactSensitive(req.body);
      if (body !== undefined && JSON.stringify(body).length > MAX_BODY_CHARS) body = { truncated: true };
      sink
        .record({
          actorType: auth.principal ?? "owner",
          actorId: auth.userId ?? null,
          actorRole: auth.role,
          action: `${req.method} ${req.route ?? "unmatched"}`,
          route: req.route ?? null,
          path: (req.url ?? "/").split("?")[0] as string,
          params: req.params,
          statusCode: res.statusCode,
          requestId: req.id,
          ip: options.clientIp(req),
          body,
        })
        .catch((err: unknown) =>
          req.log.error("Failed to write audit log", { message: err instanceof Error ? err.message : String(err) })
        );
    });
    next();
  };
}
