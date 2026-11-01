import type { AppRequest } from "../engine/http/request";
import type { AppResponse } from "../engine/http/response";
import type { NextFunction } from "../engine/router";
import type { Logger } from "../engine/logger";

/**
 * يسجل سطراً لكل طلب بعد انتهاء الرد:  "METHOD المسار رمز_الحالة المدة"
 * مثال:  [2026-10-05T12:25:40.268Z] INFO GET /products/2 200 1ms
 *
 * لماذا لا نسجل فوراً؟ لأننا لا نعرف رمز الحالة ولا المدة إلا بعد إرسال الرد. لذلك
 * نسجّل "مستمعاً" لحدث finish الذي يطلقه Node عند انتهاء الرد، ثم نكمل السلسلة فوراً.
 *
 * ملاحظة: يعمل بعد cors في المعالجات العامة. طلب OPTIONS ينتهي عند cors قبل أن يصل إلى
 * هنا، لذلك لا يظهر له سطر في السجل.
 */
export function requestLogger(logger: Logger) {
  return function requestLoggerMiddleware(req: AppRequest, res: AppResponse, next: NextFunction): void {
    const start = Date.now();
    // هذه الدالة لا تعمل الآن، بل لاحقاً عند انتهاء الرد. وتتذكر start (Closure) لتحسب المدة.
    res.on("finish", () => {
      logger.info(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - start}ms`);
    });
    next();
  };
}
