import { createHash, timingSafeEqual } from "node:crypto";
import type { AppRequest } from "../engine/http/request";
import type { AppResponse } from "../engine/http/response";
import type { NextFunction } from "../engine/router";
import type { AccessControl, Permission } from "../engine/access-control";
import { UnauthorizedError, ForbiddenError, ErrorCodes } from "../engine/errors";
import { verifyToken, type TokenPayload } from "../engine/auth-token";
import { withMeta } from "../engine/route-meta";

/** نوع req.auth بعد التأكد أنه موجود (NonNullable تحذف undefined من النوع). */
type Auth = NonNullable<AppRequest["auth"]>;

/**
 * من يتحقق أن جلسة التوكن ما زالت سارية. ينفّذه src/runtime/sessions.ts فوق جدول auth_sessions.
 * يرجع الدور الحالي (للموظف: من جدول staff، فتغيير دوره يسري فوراً)، أو null إن أُلغيت الجلسة
 * أو انتهت أو أُوقف الحساب.
 */
export interface SessionVerifier {
  verify(payload: TokenPayload): Promise<{ role: string } | null>;
}

/** بصمة SHA-256 لمفتاح، لنقارن بصمتين متساويتي الطول دائماً بزمن ثابت. */
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * هل المفتاح المرسل واحد من المفاتيح المقبولة؟ بزمن ثابت.
 * المقارنة بـ === تتوقف عند أول حرف مختلف، فيكشف زمن الرد (نظرياً) كم حرفاً صحيحاً خمّن المهاجم.
 * نقارن بصمات SHA-256 بـ timingSafeEqual: طولها ثابت (32 بايت) مهما كان طول المفتاح.
 */
function matchesAnyKey(provided: string, keys: readonly string[]): boolean {
  const given = digest(provided);
  let ok = false;
  // لا نتوقف عند أول تطابق، حتى يبقى الزمن نفسه أياً كان المفتاح الذي طابق.
  for (const key of keys) if (timingSafeEqual(given, digest(key))) ok = true;
  return ok;
}

export interface AuthenticatorOptions {
  ownerApiKey: string;
  /** مفاتيح مالك قديمة ما زالت تُقبل أثناء تغيير المفتاح. */
  previousOwnerApiKeys?: readonly string[];
  tokenSecret: string;
  /** أسرار توقيع قديمة ما زالت تُقبل أثناء تغيير السر. */
  previousTokenSecrets?: readonly string[];
  /** إن مُرّر: كل توكن يجب أن يحمل جلسة سارية. بدونه: التحقق من التوقيع والمدة فقط (السلوك القديم). */
  sessions?: SessionVerifier;
}

/**
 * المصادقة التي يستخدمها الإطار فعلاً (يُنشئها createCommerceApp في src/app.ts).
 * تتعرف على ثلاثة أنواع من المرسلين:
 *
 *   ترويسة X-Api-Key بمفتاح المالك          تعطي { role: "owner", principal: "owner" }
 *   Authorization: Bearer <توكن زبون>       تعطي { role: "customer", userId, sessionId }
 *   Authorization: Bearer <توكن موظف>       تعطي { role: <دوره الحالي>, userId, sessionId }
 *
 * وترجع معالجين:
 *   - required: يرفض الطلب المجهول بـ 401. للمسارات التي تحتاج دخولاً (مثل إضافة منتج).
 *   - optional: يسمح للمجهول بالمرور (الضيف يشتري، والكتالوج عام)، ويتعرف على المرسل إن عرّف نفسه.
 *
 * قاعدة أمان مهمة في الاثنين: من أرسل بيانات دخول خاطئة يُرفض دائماً. مفتاح خاطئ أو توكن
 * منتهي لا يتحول أبداً بصمت إلى "زائر مجهول"، حتى لا يظن المالك أنه دخل وهو لم يدخل.
 *
 * رسالة التوكن المرفوض ثابتة "Invalid or expired token" لأن موقع المتجر يعتمد عليها ليمسح
 * الجلسة ويعيد الطلب كضيف (storefront/web/js/api.js). الرمز INVALID_TOKEN هو الطريقة الأفضل.
 */
export function createAuthenticator(options: AuthenticatorOptions) {
  const ownerKeys = [options.ownerApiKey, ...(options.previousOwnerApiKeys ?? [])];
  const secrets = [options.tokenSecret, ...(options.previousTokenSecrets ?? [])];
  const invalidToken = () => new UnauthorizedError("Invalid or expired token", ErrorCodes.INVALID_TOKEN);

  /**
   * يحدد من أرسل الطلب، ولا يقرر شيئاً بعد. يرجع واحدة من ثلاث نتائج:
   *   { auth }   : عرفناه.
   *   { error }  : أرسل بيانات دخول لكنها خاطئة.
   *   {}         : لم يرسل شيئاً (مجهول).
   */
  async function identify(req: AppRequest): Promise<{ auth?: Auth; error?: UnauthorizedError }> {
    const apiKey = req.headers["x-api-key"];
    if (apiKey !== undefined) {
      return typeof apiKey === "string" && matchesAnyKey(apiKey, ownerKeys)
        ? { auth: { role: "owner", principal: "owner" } }
        : { error: new UnauthorizedError("Invalid API key", ErrorCodes.INVALID_API_KEY) };
    }
    const header = req.headers.authorization;
    if (header !== undefined) {
      const match = /^Bearer (\S+)$/.exec(header);
      const payload = match?.[1] ? verifyToken(match[1], secrets) : null;
      if (!payload) return { error: invalidToken() };
      let role = payload.role;
      if (options.sessions) {
        if (!payload.sid) return { error: invalidToken() };
        const session = await options.sessions.verify(payload);
        if (!session) return { error: invalidToken() };
        role = session.role;
      }
      const auth: Auth = { role, userId: payload.sub, principal: payload.pt ?? "customer" };
      if (payload.sid) auth.sessionId = payload.sid;
      return { auth };
    }
    return {};
  }

  /** يتطلب مرسلاً معروفاً: الخطأ أو المجهول يعطي 401، وإلا يضع req.auth ويكمل. */
  const required = withMeta(
    async function authenticate(req: AppRequest, _res: AppResponse, next: NextFunction): Promise<void> {
      const { auth, error } = await identify(req);
      if (error) return next(error);
      if (!auth) return next(new UnauthorizedError("Authentication required"));
      req.auth = auth;
      next();
    },
    { auth: "required" }
  );

  /** المجهول يمر بلا req.auth. بيانات الدخول الخاطئة ما زالت تعطي 401. */
  const optional = withMeta(
    async function authenticateOptional(req: AppRequest, _res: AppResponse, next: NextFunction): Promise<void> {
      const { auth, error } = await identify(req);
      if (error) return next(error);
      if (auth) req.auth = auth;
      next();
    },
    { auth: "optional" }
  );

  return { required, optional };
}

/*
 * المصادقة (Authentication: من أنت؟) والتفويض (Authorization: هل يحق لك هذا؟) خطوتان منفصلتان:
 *
 *   createAuthenticator  : المصادقة، وتضع req.auth (أعلاه).
 *   requirePermission    : التفويض، ويفحص req.auth.role مقابل جدول الصلاحيات (AccessControl).
 *
 * لهذا يُكتب المسار المحمي هكذا (من src/modules/products/index.ts):
 *   router.post("/products", authenticate, canWrite, withInput(...))
 * أولاً من أنت، ثم هل يحق لك، ثم هل بياناتك صحيحة، ثم التنفيذ.
 *
 * الدوال requireApiKey و optionalApiKey و requireRole التالية أدوات أبسط وأقدم، باقية في
 * الواجهة العامة (src/index.ts) لمن يحتاجها، لكن الإطار نفسه يستخدم createAuthenticator.
 */

/** يقبل مفتاح المالك فقط (X-Api-Key). أي طلب بدونه أو بمفتاح خاطئ يعطي 401. */
export function requireApiKey(ownerApiKey: string) {
  return withMeta(
    function requireApiKeyMiddleware(req: AppRequest, _res: AppResponse, next: NextFunction): void {
      const provided = req.headers["x-api-key"];
      if (typeof provided !== "string" || !matchesAnyKey(provided, [ownerApiKey])) {
        next(new UnauthorizedError("Missing or invalid API key", ErrorCodes.INVALID_API_KEY));
        return;
      }
      req.auth = { role: "owner", principal: "owner" };
      next();
    },
    { auth: "required" }
  );
}

/**
 * مثل requireApiKey، لكن الطلب الذي لا يحمل الترويسة يكمل كمجهول.
 * الطلب الذي يحمل مفتاحاً خاطئاً يُرفض، فخطأ مطبعي في المفتاح لا يحوّل المالك بصمت
 * إلى زائر عادي.
 */
export function optionalApiKey(ownerApiKey: string) {
  return withMeta(
    function optionalApiKeyMiddleware(req: AppRequest, _res: AppResponse, next: NextFunction): void {
      const provided = req.headers["x-api-key"];
      if (provided === undefined) {
        next();
        return;
      }
      if (typeof provided !== "string" || !matchesAnyKey(provided, [ownerApiKey])) {
        next(new UnauthorizedError("Invalid API key", ErrorCodes.INVALID_API_KEY));
        return;
      }
      req.auth = { role: "owner", principal: "owner" };
      next();
    },
    { auth: "optional" }
  );
}

/**
 * التفويض حسب الصلاحية. يُوضع في السلسلة بعد المصادقة:
 *   - لا أحد معروف (لا req.auth): 401، أي "سجّل دخولك".
 *   - معروف لكن دوره لا يملك الصلاحية: 403، أي "غير مسموح لك".
 * مثال: canWrite = requirePermission(accessControl, "products:write") في وحدة المنتجات.
 */
export function requirePermission(accessControl: AccessControl, permission: Permission) {
  return withMeta(
    function requirePermissionMiddleware(req: AppRequest, _res: AppResponse, next: NextFunction): void {
      if (!req.auth) {
        next(new UnauthorizedError("Authentication required"));
        return;
      }
      if (!accessControl.can(req.auth.role, permission)) {
        next(new ForbiddenError(`Missing permission: ${permission}`));
        return;
      }
      next();
    },
    { permission }
  );
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
