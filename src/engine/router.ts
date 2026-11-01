import type { AppRequest } from "./http/request";
import type { AppResponse } from "./http/response";
import { ValidationError, ErrorCodes } from "./errors";
import { readMeta, type RouteMeta } from "./route-meta";

/**
 * دالة "التالي" التي يستلمها كل معالج في السلسلة:
 *   - next()     : انتقل إلى المعالج التالي.
 *   - next(err)  : توقف، واذهب مباشرة إلى معالج الأخطاء (onError في server.ts).
 */
export type NextFunction = (err?: unknown) => void;

/**
 * الشكل الموحد لأي معالج في الإطار: الـ middleware (مثل cors و authenticate و validateBody)
 * والـ handler الأخير للمسار، كلهم بنفس الشكل. لهذا يمكن وضعهم جميعاً في مصفوفة واحدة
 * وتشغيلهم بالترتيب (middleware-pipeline.ts).
 * النتيجة void أو Promise<void>: أي أن المعالج قد يكون دالة عادية أو async.
 */
export type Handler = (req: AppRequest, res: AppResponse, next: NextFunction) => void | Promise<void>;

/** الطرق التي يدعمها الـ Router. أي نص آخر (مثل "GTE" بالخطأ) يرفضه TypeScript قبل التشغيل. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** ما يحفظه الـ Router عن كل مسار مسجّل. */
interface Route {
  /** الطريقة، مثل "GET". */
  method: HttpMethod;
  /** المسار كما سُجّل، مثل "/products/:id". تستخدمه المقاييس والسجل والتدقيق بدل الرابط الحقيقي. */
  path: string;
  /** المسار بعد تحويله إلى تعبير نمطي (انظر compilePath). */
  pattern: RegExp;
  /** أسماء متغيرات المسار بالترتيب، مثل ["id", "productId"]. */
  paramNames: string[];
  /** كل المعالجات ما عدا الأخير، وتعمل قبله (مصادقة، صلاحيات، تحقق...). */
  middleware: Handler[];
  /** المعالج الأخير الذي ينفّذ عمل المسار ويرسل الرد. */
  handler: Handler;
  /** المعلومات الوصفية المجموعة من معالجات المسار (engine/route-meta.ts). */
  meta: RouteMeta;
}

/** نتيجة البحث الناجح: المسار الذي طابق، وقيم متغيراته. */
export interface RouteMatch {
  route: Route;
  /** مثال: الطلب "/products/2" على المسار "/products/:id" يعطي { id: "2" } */
  params: Record<string, string>;
}

/** وصف مسار للقراءة فقط، لمن يحتاج قائمة المسارات (مولّد OpenAPI مثلاً). */
export interface RouteInfo {
  method: HttpMethod;
  path: string;
  paramNames: readonly string[];
  meta: RouteMeta;
}

/**
 * يحوّل مساراً مثل "/products/:id" إلى تعبير نمطي (RegExp) يلتقط الجزء ":id".
 *
 * مثال كامل على "/carts/:id/items/:productId":
 *   1. split("/") يعطي ["", "carts", ":id", "items", ":productId"]
 *   2. كل جزء يبدأ بـ ":" يصبح ([^/]+) ويُحفظ اسمه، فتصبح paramNames = ["id", "productId"]
 *   3. join("/") ثم نضيف ^ في البداية و /?$ في النهاية، فتكون النتيجة:
 *        ^/carts/([^/]+)/items/([^/]+)/?$
 *
 * معاني الرموز:
 *   ^ و $   : المطابقة للمسار كاملاً، فلا يُقبل شيء زائد قبله أو بعده.
 *   ( ... ) : مجموعة التقاط، نقرأ ما طابقها بعد ذلك.
 *   [^/]+   : حرف واحد أو أكثر، ليس منها "/" (المتغير لا يكون فارغاً ولا يعبر الأجزاء).
 *   /?      : شرطة مائلة اختيارية في النهاية، فيعمل "/products/2/" أيضاً.
 *
 * لماذا كتبناه بأنفسنا ولم نستخدم مكتبة مثل path-to-regexp؟ مسارات الإطار بسيطة
 * (أجزاء ثابتة، وأجزاء ":param")، فهذا الكود القصير أخف من اعتمادية، وكل سطر فيه مفهوم.
 */
function compilePath(path: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const segments = path
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        // slice(1) تحذف الحرف الأول ":"، فيبقى الاسم فقط، مثل "id".
        paramNames.push(segment.slice(1));
        return "([^/]+)";
      }
      // الأجزاء الثابتة: نضع "\" قبل كل رمز له معنى خاص في التعبيرات النمطية.
      // مثال: النقطة "." تعني "أي حرف"، فبدون هذا السطر يطابق "/files/v1.2" أيضاً "/files/v1x2".
      // و "$&" في الاستبدال تعني "الحرف الذي طابق" نفسه.
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    });
  return { pattern: new RegExp(`^${segments.join("/")}/?$`), paramNames };
}

/**
 * يفك ترميز متغير المسار: "%D8%B9%D9%84%D9%8A" تصبح "علي"، و "a%20b" تصبح "a b".
 * الترميز المعطوب (مثل "%E0%A4%A") خطأ العميل، فيصبح 400 برمز MALFORMED_URL،
 * لا 500 كما كان قبل هذا الإصلاح (decodeURIComponent ترمي URIError).
 */
function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ValidationError("Malformed URL encoding", undefined, ErrorCodes.MALFORMED_URL);
  }
}

/**
 * نظام التوجيه: يحفظ المسارات المسجلة، ويجد لكل طلب المسار الذي يخدمه.
 *
 * الوحدات تسجّل مساراتها عند الإقلاع، مثلاً في src/modules/cart/index.ts:
 *   router.post("/carts/:id/items", authenticateOptional, withInput(...))
 * وعند كل طلب يسأل server.ts الدالة match: من يخدم هذه الطريقة وهذا المسار؟
 *
 * قاعدة مهمة: أول مسار يطابق يفوز، بترتيب التسجيل. لذلك المسار الثابت يُسجَّل قبل
 * المسار ذي المتغير. مثال حقيقي: "/customers/me" مسجّل قبل "/customers/:id"، ولو انعكس
 * الترتيب لذهب طلب "/customers/me" إلى مسار ":id" بقيمة id = "me".
 *
 * و HEAD يُخدم بمسار GET نفسه: Node لا يرسل جسم الرد مع HEAD، فيصل للعميل الرمز والترويسات فقط.
 */
export class Router {
  // private: لا يصل إليها كود خارج الصنف. readonly: لا يمكن استبدال المصفوفة، بل الإضافة إليها فقط.
  private readonly routes: Route[] = [];

  /** يسجّل مساراً. التحويل إلى تعبير نمطي يحدث هنا مرة واحدة، لا مع كل طلب. */
  private add(method: HttpMethod, path: string, handlers: Handler[]): void {
    // مسار بلا handler خطأ برمجي: نرفضه عند الإقلاع فوراً (Fail fast) لا عند أول طلب.
    if (handlers.length === 0) {
      throw new Error(`Route ${method} ${path} needs at least one handler`);
    }
    // نفس الطريقة ونفس المسار مرتين: الثاني لن يعمل أبداً (الأول يفوز دائماً)،
    // وهذا غالباً إضافة تتعارض مع وحدة. نرفضه عند الإقلاع بدل أن يختفي بصمت.
    if (this.routes.some((r) => r.method === method && r.path === path)) {
      throw new Error(`Route ${method} ${path} is already registered`);
    }
    const { pattern, paramNames } = compilePath(path);
    // العنصر الأخير هو الـ handler. "as Handler" لأن الإعداد noUncheckedIndexedAccess يجعل
    // TypeScript يعتبر أي array[i] قد يكون undefined، ونحن تأكدنا أعلاه أن المصفوفة ليست فارغة.
    const handler = handlers[handlers.length - 1] as Handler;
    // slice(0, -1) تعني كل العناصر ما عدا الأخير، مثلاً [auth, validate, handler] تعطي [auth, validate].
    const middleware = handlers.slice(0, -1);
    // push تضيف في آخر القائمة، فترتيب القائمة هو ترتيب التسجيل.
    this.routes.push({ method, path, pattern, paramNames, middleware, handler, meta: readMeta(handlers) });
  }

  // دوال التسجيل الخمس. "...handlers" (Rest parameters) تجمع كل المعاملات بعد path في مصفوفة،
  // لهذا يمكن كتابة router.get("/x", handler) أو router.post("/y", auth, validate, handler).
  get(path: string, ...handlers: Handler[]): void {
    this.add("GET", path, handlers);
  }
  post(path: string, ...handlers: Handler[]): void {
    this.add("POST", path, handlers);
  }
  put(path: string, ...handlers: Handler[]): void {
    this.add("PUT", path, handlers);
  }
  patch(path: string, ...handlers: Handler[]): void {
    this.add("PATCH", path, handlers);
  }
  delete(path: string, ...handlers: Handler[]): void {
    this.add("DELETE", path, handlers);
  }

  /**
   * يبحث عن مسار يطابق الطريقة والمسار. يرجع المسار ومتغيراته، أو null إن لم يوجد
   * (فيسأل server.ts عن allowedMethods ليقرر بين 404 و 405).
   *
   * مثال: match("PUT", "/carts/c-77/items/p-5")
   *   exec يعطي ["/carts/c-77/items/p-5", "c-77", "p-5"]: العنصر 0 النص كله، وما بعده الالتقاطات
   *   paramNames = ["id", "productId"]، فالاسم رقم i يقابل الالتقاط رقم i + 1
   *   النتيجة: { id: "c-77", productId: "p-5" }
   */
  match(method: string, pathname: string): RouteMatch | null {
    const wanted = method === "HEAD" ? "GET" : method;
    for (const route of this.routes) {
      // الطريقة مختلفة: نتجاوز المسار فوراً دون تجربة التعبير النمطي.
      if (route.method !== wanted) continue;
      const result = route.pattern.exec(pathname);
      if (!result) continue;
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeParam(result[i + 1] ?? "");
      });
      // أول مسار يطابق يُرجَع فوراً، ولا نكمل البحث.
      return { route, params };
    }
    return null;
  }

  /**
   * الطرق التي يقبلها هذا المسار، بأي طريقة. قائمة فارغة تعني أن المسار نفسه غير موجود (404)،
   * وغير فارغة تعني أن المسار موجود بطريقة أخرى (405 مع ترويسة Allow).
   */
  allowedMethods(pathname: string): string[] {
    const methods = new Set<string>();
    for (const route of this.routes) if (route.pattern.test(pathname)) methods.add(route.method);
    if (methods.has("GET")) methods.add("HEAD");
    return [...methods];
  }

  /** كل المسارات المسجلة بترتيبها، للقراءة فقط (يستخدمها مولّد OpenAPI). */
  list(): RouteInfo[] {
    return this.routes.map(({ method, path, paramNames, meta }) => ({ method, path, paramNames, meta }));
  }
}
