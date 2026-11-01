import type { IncomingMessage } from "node:http";

/**
 * عنوان IP لمن أرسل الطلب.
 *
 * يستخدمه حد المحاولات (rate limiter) في الدخول والتسجيل: المحاولات الفاشلة تُعدّ
 * لكل عنوان، فيجب أن نعرف العنوان الحقيقي، وألا يستطيع المهاجم تزويره.
 * يصل إلى الوحدات عبر context.clientIp (src/app.ts).
 *
 * حالتان:
 *
 * 1. بدون Reverse proxy، وهو الوضع الافتراضي (trustProxy = false):
 *    العميل يتصل بخادمنا مباشرة، فعنوان الاتصال نفسه (req.socket.remoteAddress)
 *    هو عنوانه الحقيقي. لا يمكن تزويره، لأن الرد يجب أن يعود إليه.
 *
 * 2. خلف Reverse proxy واحد موثوق، مثل nginx على نفس الخادم (trustProxy = true):
 *    كل الاتصالات تأتي من الـ proxy، فعنوان الاتصال هو عنوان الـ proxy للجميع.
 *    لذلك يضيف الـ proxy العنوان الحقيقي في آخر ترويسة X-Forwarded-For.
 *    مثال: أرسل المهاجم بنفسه عنواناً مزوراً 1.1.1.1 في هذه الترويسة،
 *    ثم أضاف الـ proxy عنوانه الحقيقي في آخرها، فوصلتنا هكذا:
 *        X-Forwarded-For: 1.1.1.1, 203.0.113.7
 *    نأخذ الأخير فقط (203.0.113.7)، لأنه الوحيد الذي كتبه الـ proxy. ما قبله كتبه
 *    العميل، ولو صدّقناه لاختار المهاجم عنواناً جديداً مع كل محاولة، فيتجاوز حد المحاولات.
 *
 * لا تفعّل trustProxy (أي TRUST_PROXY=true في .env) إلا إذا كان أمام التطبيق proxy فعلاً،
 * لأنه بدون proxy تكون الترويسة كلها من كتابة العميل.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const header = req.headers["x-forwarded-for"];
    // نوع الترويسة في TypeScript نص أو مصفوفة، فنتعامل مع الحالتين. عملياً Node يدمج
    // الترويسة المكررة في نص واحد بفواصل: "1.1.1.1, 203.0.113.7".
    const value = Array.isArray(header) ? header[header.length - 1] : header;
    // نقسم النص عند الفواصل، ونأخذ آخر عنوان، ونحذف المسافات حوله.
    // و "?." تحمي من ترويسة غير موجودة: تعطي undefined بدل أن ينهار الكود.
    const last = value?.split(",").pop()?.trim();
    if (last) return last;
  }
  // عنوان الاتصال المباشر. و "unknown" احتياط إن انقطع الاتصال قبل قراءة العنوان.
  return req.socket.remoteAddress ?? "unknown";
}
