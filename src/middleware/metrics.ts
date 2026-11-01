import type { AppRequest } from "../engine/http/request";
import type { AppResponse } from "../engine/http/response";
import type { NextFunction } from "../engine/router";
import type { MetricsRegistry } from "../engine/metrics";

/** الطرق المعروفة. أي طريقة غريبة تُعدّ "OTHER" حتى لا يصنع مهاجم سلسلة مقاييس لكل نص يرسله. */
const KNOWN_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/**
 * يقيس كل طلب بعد انتهائه: عدد الطلبات حسب الطريقة والمسار ورمز الحالة، ومدة كل طلب.
 * هذان المقياسان يكفيان لطريقة RED المعروفة في المراقبة: Rate (المعدل)، و Errors (الأخطاء،
 * أي status من 5xx)، و Duration (المدة).
 *
 * المسار هو المسجّل ("/products/:id")، أو "unmatched" لطلب لم يطابق أي مسار (404).
 */
export function httpMetrics(registry: MetricsRegistry) {
  const requests = registry.counter("http_requests_total", "HTTP requests served, by method, route and status");
  const duration = registry.histogram("http_request_duration_seconds", "HTTP request duration in seconds");

  return function httpMetricsMiddleware(req: AppRequest, res: AppResponse, next: NextFunction): void {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const method = KNOWN_METHODS.has(req.method ?? "") ? (req.method as string) : "OTHER";
      const route = req.route ?? "unmatched";
      requests.inc({ method, route, status: String(res.statusCode) });
      duration.observe({ method, route }, Number(process.hrtime.bigint() - start) / 1e9);
    });
    next();
  };
}
