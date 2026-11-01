import type { AppRequest } from "../engine/http/request";
import type { AppResponse } from "../engine/http/response";
import type { NextFunction } from "../engine/router";
import type { AccessControl, Permission } from "../engine/access-control";
import { UnauthorizedError, ForbiddenError } from "../engine/errors";
import { verifyToken } from "../engine/auth-token";

/** نوع req.auth بعد التأكد أنه موجود (NonNullable تحذف undefined من النوع). */
type Auth = NonNullable<AppRequest["auth"]>;

/**
 * المصادقة التي يستخدمها الإطار فعلاً (يُنشئها createCommerceApp في src/app.ts).
 * تتعرف على نوعين من المرسلين:
 *
 *   ترويسة X-Api-Key بمفتاح المالك          تعطي { role: "owner" }
 *   ترويسة Authorization: Bearer <توكن>     تعطي { role: "customer", userId } (يصدر عند الدخول)
 *
 * وترجع معالجين:
 *   - required: يرفض الطلب المجهول بـ 401. للمسارات التي تحتاج دخولاً (مثل إضافة منتج).
 *   - optional: يسمح للمجهول بالمرور (الضيف يشتري، والكتالوج عام)، ويتعرف على المرسل إن عرّف نفسه.
 *
 * قاعدة أمان مهمة في الاثنين: من أرسل بيانات دخول خاطئة يُرفض دائماً. مفتاح خاطئ أو توكن
 * منتهي لا يتحول أبداً بصمت إلى "زائر مجهول"، حتى لا يظن المالك أنه دخل وهو لم يدخل.
 */
export function createAuthenticator(options: { ownerApiKey: string; tokenSecret: string }) {
  /**
   * يحدد من أرسل الطلب، ولا يقرر شيئاً بعد. يرجع واحدة من ثلاث نتائج:
   *   { auth }   : عرفناه.
   *   { error }  : أرسل بيانات دخول لكنها خاطئة.
   *   {}         : لم يرسل شيئاً (مجهول).
   */
  function identify(req: AppRequest): { auth?: Auth; error?: UnauthorizedError } {
    // 1. مفتاح المالك في ترويسة X-Api-Key (Node يحوّل أسماء الترويسات إلى حروف صغيرة).
    const apiKey = req.headers["x-api-key"];
    if (apiKey !== undefined) {
      // تنبيه: المقارنة بـ === ليست ثابتة الزمن (قيد معروف ومذكور في التقرير).
      return apiKey === options.ownerApiKey
        ? { auth: { role: "owner" } }
        : { error: new UnauthorizedError("Invalid API key") };
    }
    // 2. توكن الزبون في ترويسة Authorization بالشكل "Bearer <token>".
    const header = req.headers.authorization;
    if (header !== undefined) {
      // التعبير النمطي يلتقط التوكن بعد "Bearer ": أحرف بلا مسافات (\S+).
      const match = /^Bearer (\S+)$/.exec(header);
      // verifyToken يتحقق من التوقيع والمدة (engine/auth-token.ts).
      const payload = match?.[1] ? verifyToken(match[1], options.tokenSecret) : null;
      if (!payload) return { error: new UnauthorizedError("Invalid or expired token") };
      return { auth: { role: payload.role, userId: payload.sub } };
    }
    // 3. لا هذا ولا ذاك: مجهول.
    return {};
  }

  return {
    /** يتطلب مرسلاً معروفاً: الخطأ أو المجهول يعطي 401، وإلا يضع req.auth ويكمل. */
    required(req: AppRequest, _res: AppResponse, next: NextFunction): void {
      const { auth, error } = identify(req);
      if (error) return next(error);
      if (!auth) return next(new UnauthorizedError("Authentication required"));
      req.auth = auth;
      next();
    },
    /** المجهول يمر بلا req.auth. بيانات الدخول الخاطئة ما زالت تعطي 401. */
    optional(req: AppRequest, _res: AppResponse, next: NextFunction): void {
      const { auth, error } = identify(req);
      if (error) return next(error);
      if (auth) req.auth = auth;
      next();
    },
  };
}

/*
 * المصادقة (Authentication: من أنت؟) والتفويض (Authorization: هل يحق لك هذا؟) خطوتان منفصلتان:
 *
 *   createAuthenticator  : المصادقة، وتضع req.auth (أعلاه).
 *   requirePermission    : التفويض، ويفحص req.auth.role مقابل جدول الصلاحيات (AccessControl).
 *
 * لهذا يُكتب المسار المحمي هكذا (من src/modules/products/index.ts):
 *   router.post("/products", authenticate, canWrite, validateBody(...), handler)
 * أولاً من أنت، ثم هل يحق لك، ثم هل بياناتك صحيحة، ثم التنفيذ.
 *
 * الدوال requireApiKey و optionalApiKey و requireRole التالية أدوات أبسط وأقدم، باقية في
 * الواجهة العامة (src/index.ts) لمن يحتاجها، لكن الإطار نفسه يستخدم createAuthenticator.
 */

/** يقبل مفتاح المالك فقط (X-Api-Key). أي طلب بدونه أو بمفتاح خاطئ يعطي 401. */
export function requireApiKey(ownerApiKey: string) {
  return function requireApiKeyMiddleware(req: AppRequest, _res: AppResponse, next: NextFunction): void {
    const provided = req.headers["x-api-key"];
    if (!provided || provided !== ownerApiKey) {
      next(new UnauthorizedError("Missing or invalid API key"));
      return;
    }
    req.auth = { role: "owner" };
    next();
  };
}

/**
 * مثل requireApiKey، لكن الطلب الذي لا يحمل الترويسة يكمل كمجهول.
 * الطلب الذي يحمل مفتاحاً خاطئاً يُرفض، فخطأ مطبعي في المفتاح لا يحوّل المالك بصمت
 * إلى زائر عادي.
 */
export function optionalApiKey(ownerApiKey: string) {
  return function optionalApiKeyMiddleware(req: AppRequest, _res: AppResponse, next: NextFunction): void {
    const provided = req.headers["x-api-key"];
    if (provided === undefined) {
      next();
      return;
    }
    if (provided !== ownerApiKey) {
      next(new UnauthorizedError("Invalid API key"));
      return;
    }
    req.auth = { role: "owner" };
    next();
  };
}

/**
 * التفويض حسب الصلاحية. يُوضع في السلسلة بعد المصادقة:
 *   - لا أحد معروف (لا req.auth): 401، أي "سجّل دخولك".
 *   - معروف لكن دوره لا يملك الصلاحية: 403، أي "غير مسموح لك".
 * مثال: canWrite = requirePermission(accessControl, "products:write") في وحدة المنتجات.
 */
export function requirePermission(accessControl: AccessControl, permission: Permission) {
  return function requirePermissionMiddleware(req: AppRequest, _res: AppResponse, next: NextFunction): void {
    if (!req.auth) {
      next(new UnauthorizedError("Authentication required"));
      return;
    }
    if (!accessControl.can(req.auth.role, permission)) {
      next(new ForbiddenError(`Missing permission: ${permission}`));
      return;
    }
    next();
  };
}

/** فحص أخشن حسب اسم الدور نفسه. للمسارات الجديدة الأفضل requirePermission (انظر access-control.ts). */
export function requireRole(role: string) {
  return function requireRoleMiddleware(req: AppRequest, _res: AppResponse, next: NextFunction): void {
    if (!req.auth) {
      next(new UnauthorizedError("Authentication required"));
      return;
    }
    if (req.auth.role !== role) {
      next(new ForbiddenError(`Requires role: ${role}`));
      return;
    }
    next();
  };
}
