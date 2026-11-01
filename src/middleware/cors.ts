import type { AppRequest } from "../engine/http/request";
import type { AppResponse } from "../engine/http/response";
import type { NextFunction } from "../engine/router";

/**
 * CORS (Cross-Origin Resource Sharing): إذن المتصفح لموقع على عنوان معين باستدعاء الـ API
 * على عنوان آخر.
 *
 * المشكلة: موقع المتجر على http://localhost:5173 والـ API على http://localhost:3000. المتصفح،
 * لحماية المستخدم، يمنع الموقع من قراءة ردود عنوان مختلف، إلا إذا سمح الخادم بذلك صراحة
 * بهذه الترويسات.
 *
 * وقبل بعض الطلبات (مثل POST بـ JSON، أو أي طلب فيه ترويسة Authorization)، يرسل المتصفح
 * أولاً طلب OPTIONS يسأل: "هل تسمح لي؟". اسمه Preflight. نرد عليه هنا مباشرة بـ 204
 * (نجح، بلا جسم)، ولا نكمل السلسلة، لأنه لا يوجد مسار OPTIONS في الـ Router.
 * و Access-Control-Max-Age يسمح للمتصفح بتذكّر الجواب 10 دقائق بدل أن يسأل قبل كل طلب.
 *
 * هذا المعالج يعمل أولاً على كل طلب، حتى قبل البحث عن المسار (انظر engine/http/server.ts).
 * لو لم يكن أولاً، لأخذ طلب OPTIONS رد 404 دون هذه الترويسات، فيمنع المتصفح الطلب الحقيقي.
 * هذا كان الخطأ رقم 1 في جدول 6.5 في التقرير.
 *
 * origin: المواقع المسموحة، من الإعداد CORS_ORIGIN:
 *   - "*"                                   : أي موقع.
 *   - "https://shop.ly"                     : موقع واحد.
 *   - "https://shop.ly,https://admin.shop.ly": عدة مواقع (أو مصفوفة). المتصفح لا يقبل في الترويسة
 *     إلا موقعاً واحداً، فنعيد إليه موقعه هو إن كان في القائمة، ونضيف Vary: Origin حتى لا يخزّن
 *     وسيط (CDN) رد موقع ويعطيه لموقع آخر.
 *
 * Expose-Headers: الترويسات التي يُسمح لكود الموقع بقراءتها من الرد (غيرها يخفيه المتصفح)،
 * مثل X-Total-Count لعدد الصفحات، و ETag للتعديل المتفائل، و X-Request-Id لرسائل الدعم.
 */
export function cors(origin: string | readonly string[]) {
  const list = (typeof origin === "string" ? origin.split(",") : [...origin]).map((o) => o.trim()).filter(Boolean);
  const anyOrigin = list.length === 0 || list.includes("*");

  return function corsMiddleware(req: AppRequest, res: AppResponse, next: NextFunction): void {
    if (anyOrigin) {
      res.setHeader("Access-Control-Allow-Origin", "*");
    } else {
      res.setHeader("Vary", "Origin");
      const requestOrigin = req.headers.origin;
      if (list.length === 1) res.setHeader("Access-Control-Allow-Origin", list[0] as string);
      else if (requestOrigin && list.includes(requestOrigin)) res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Api-Key, Idempotency-Key, If-Match, X-Request-Id"
    );
    res.setHeader(
      "Access-Control-Expose-Headers",
      "X-Request-Id, X-Total-Count, ETag, Retry-After, Idempotency-Replayed"
    );
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Max-Age", "600");
      res.statusCode = 204;
      res.end();
      return;
    }
    next();
  };
}
