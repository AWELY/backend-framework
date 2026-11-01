import type { AppRequest } from "../engine/http/request";
import type { AppResponse } from "../engine/http/response";
import type { NextFunction } from "../engine/router";

/**
 * CORS (Cross-Origin Resource Sharing): إذن المتصفح لموقع على عنوان معين باستدعاء الـ API
 * على عنوان آخر.
 *
 * المشكلة: موقع AMA على http://localhost:5173 والـ API على http://localhost:3000. المتصفح،
 * لحماية المستخدم، يمنع الموقع من قراءة ردود عنوان مختلف، إلا إذا سمح الخادم بذلك صراحة
 * بهذه الترويسات.
 *
 * وقبل بعض الطلبات (مثل POST بـ JSON، أو أي طلب فيه ترويسة Authorization)، يرسل المتصفح
 * أولاً طلب OPTIONS يسأل: "هل تسمح لي؟". اسمه Preflight. نرد عليه هنا مباشرة بـ 204
 * (نجح، بلا جسم)، ولا نكمل السلسلة، لأنه لا يوجد مسار OPTIONS في الـ Router.
 *
 * هذا المعالج يعمل أولاً على كل طلب، حتى قبل البحث عن المسار (انظر engine/http/server.ts).
 * لو لم يكن أولاً، لأخذ طلب OPTIONS رد 404 دون هذه الترويسات، فيمنع المتصفح الطلب الحقيقي.
 * هذا كان الخطأ رقم 1 في جدول 6.5 في التقرير.
 *
 * origin: الموقع المسموح، من الإعداد CORS_ORIGIN. موقع واحد فقط، أو "*" لأي موقع.
 */
export function cors(origin: string) {
  return function corsMiddleware(req: AppRequest, res: AppResponse, next: NextFunction): void {
    // من يُسمح له.
    res.setHeader("Access-Control-Allow-Origin", origin);
    // أي الطرق مسموحة.
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    // أي الترويسات يُسمح للموقع بإرسالها: صيغة الجسم، وتوكن الزبون، ومفتاح المالك.
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key");
    // طلب Preflight: نرد فوراً بـ 204 وننهي الرد، ولا نستدعي next.
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    next();
  };
}
