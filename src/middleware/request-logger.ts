import type { AppRequest } from "../engine/http/request";
import type { AppResponse } from "../engine/http/response";
import type { NextFunction } from "../engine/router";
import type { Logger } from "../engine/logger";

/**
 * يسجل سطراً لكل طلب بعد انتهاء الرد:  "METHOD المسار رمز_الحالة المدة"
 * مثال:  [2026-10-05T12:25:40.268Z] INFO GET /products/2 200 1ms req=3f2a9c1e
 * وفي صيغة JSON تُضاف الحقول منفصلة: method و path و route و status و durationMs و requestId،
 * فيمكن البحث عن "كل طلبات /orders/:id التي أخذت أكثر من 500ms".
 *
 * لماذا لا نسجل فوراً؟ لأننا لا نعرف رمز الحالة ولا المدة إلا بعد إرسال الرد. لذلك
 * نسجّل "مستمعاً" لحدث finish الذي يطلقه Node عند انتهاء الرد، ثم نكمل السلسلة فوراً.
 *
 * خصوصية: نسجّل المسار فقط، دون الاستعلام (ما بعد "?"). قبل هذا الإصلاح كان رابط تتبع الضيف
 * GET /orders/:id?phone=0912345678 يكتب رقم هاتف الزبون في السجل.
 *
 * ملاحظة: يعمل بعد cors في المعالجات العامة. طلب OPTIONS ينتهي عند cors قبل أن يصل إلى
 * هنا، لذلك لا يظهر له سطر في السجل.
 */
export function requestLogger(logger: Logger) {
  return function requestLoggerMiddleware(req: AppRequest, res: AppResponse, next: NextFunction): void {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      const log = req.log ?? logger;
      const path = (req.url ?? "/").split("?")[0];
      const line = `${req.method} ${path} ${res.statusCode} ${Math.round(durationMs)}ms`;
      if (log.format === "json") {
        log.info(line, {
          method: req.method,
          path,
          route: req.route ?? null,
          status: res.statusCode,
          durationMs: Math.round(durationMs * 10) / 10,
        });
      } else {
        log.info(line);
      }
    });
    next();
  };
}
