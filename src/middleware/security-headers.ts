import type { AppRequest } from "../engine/http/request";
import type { AppResponse } from "../engine/http/response";
import type { NextFunction } from "../engine/router";

/**
 * ترويسات أمان على كل رد. الـ API يرد بـ JSON فقط، فنقول للمتصفح ذلك صراحة:
 *
 *   X-Content-Type-Options: nosniff     لا تخمّن نوع المحتوى: JSON لا يُعامل أبداً كـ HTML أو سكربت.
 *   Content-Security-Policy: default-src 'none'; frame-ancestors 'none'
 *                                       لو فُتح رد الـ API في المتصفح مباشرة، لا يُحمَّل منه أي شيء.
 *   X-Frame-Options: DENY               لا يُعرض داخل iframe في موقع آخر (Clickjacking).
 *   Referrer-Policy: no-referrer        لا يُرسل رابط الـ API (وقد يحمل معرّفات) إلى مواقع أخرى.
 *   Strict-Transport-Security           (اختياري: hsts) المتصفح يستخدم HTTPS دائماً مع هذا النطاق.
 *                                       نفعّله فقط خلف TLS حقيقي، وإلا قفلنا المتصفح على https لا يعمل.
 *   Cache-Control: no-store             (للطلبات التي تحمل مصادقة فقط) لا يُخزَّن رد شخصي في أي ذاكرة
 *                                       مؤقتة، فلا يرى مستخدم آخر على نفس الجهاز طلبات غيره.
 */
export function securityHeaders(options: { hsts?: boolean } = {}) {
  return function securityHeadersMiddleware(req: AppRequest, res: AppResponse, next: NextFunction): void {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (options.hsts) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    if (req.headers.authorization !== undefined || req.headers["x-api-key"] !== undefined) {
      res.setHeader("Cache-Control", "no-store");
    }
    next();
  };
}
