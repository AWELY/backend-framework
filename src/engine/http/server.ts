import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import type { Router, Handler, RouteMatch } from "../router";
import type { AppRequest } from "./request";
import { enhanceResponse } from "./response";
import { runPipeline } from "../middleware-pipeline";
import type { Logger } from "../logger";
import {
  ErrorCodes,
  MethodNotAllowedError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
  toErrorResponse,
} from "../errors";

/** الحد الافتراضي لحجم جسم الطلب: 1 ميغابايت. أكبر طلب حقيقي في الإطار (طلب شراء) أقل من 5 كيلوبايت. */
export const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

/** صيغة X-Request-Id المقبولة من العميل: حروف وأرقام ورموز آمنة فقط، حتى لا يحقن أحد نصاً في السجل. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * يقرأ جسم الطلب كاملاً، ويرجعه خاماً (raw) ومحوّلاً إلى قيمة JavaScript (parsed).
 *
 * الجسم لا يصل دفعة واحدة، بل عبر الشبكة على قطع (chunks)، حوالي 64 كيلوبايت لكل قطعة.
 * Node يخبرنا بحدث "data" مع كل قطعة، وبحدث "end" عندما يكتمل الجسم، ولا يقف منتظراً
 * بينهما (يخدم طلبات أخرى في الأثناء). نحوّل هذه الأحداث إلى Promise حتى نكتب في
 * مكان الاستخدام سطراً واحداً.
 *
 * النتيجة parsed:
 *   - إن لم يوجد جسم: undefined
 *   - إن كان Content-Type فيه application/json: كائن (بـ JSON.parse)
 *   - إن كان JSON معطوباً: ValidationError برمز MALFORMED_JSON، أي رد 400
 *   - أي نوع آخر: النص كما هو
 *
 * حد الحجم (limit): بدونه كان أي أحد يستطيع إرسال جسم بمئات الميغابايتات فيملأ ذاكرة الخادم
 * (قسناها: جسم 30 ميغابايت رفع الذاكرة 128 ميغابايت). الحماية على مرحلتين:
 *   1. إن صرّح العميل بحجم أكبر من الحد في Content-Length، نرفض فوراً دون قراءة أي بايت.
 *   2. نعدّ البايتات أثناء الوصول (العميل قد لا يصرّح أو قد يكذب)، وعند تجاوز الحد نتوقف عن
 *      الجمع ونرفض بـ 413. ما يصل بعدها يُرمى ولا يُحفظ.
 */
function readBody(req: IncomingMessage, limit: number): Promise<{ raw: Buffer | undefined; parsed: unknown }> {
  // resolve(قيمة) معناها "وصلت النتيجة"، و reject(خطأ) معناها "فشل".
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new PayloadTooLargeError(limit));
      return;
    }
    // Buffer تعني بايتات خام. نجمع القطع كما هي، دون تحويلها نصاً الآن.
    let chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks = [];
        reject(new PayloadTooLargeError(limit));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
      // لم تصل أي قطعة: طلب بلا جسم، مثل GET.
      if (chunks.length === 0) {
        resolve({ raw: undefined, parsed: undefined });
        return;
      }
      // ندمج القطع أولاً ثم نحوّلها نصاً، والترتيب مهم: الحرف العربي بايتان في UTF-8،
      // وقد يقع نصفه في آخر قطعة ونصفه الآخر في أول التي تليها.
      // لو حوّلنا كل قطعة نصاً وحدها لانكسر الحرف.
      const raw = Buffer.concat(chunks);
      const text = raw.toString("utf8");
      // نقرأ الجسم كـ JSON فقط إن قال العميل إنه JSON. نستخدم includes وليس ===
      // لأن الترويسة قد تكون "application/json; charset=utf-8".
      const contentType = req.headers["content-type"] ?? "";
      if (contentType.includes("application/json")) {
        try {
          resolve({ raw, parsed: text.length ? JSON.parse(text) : undefined });
        } catch {
          // JSON المعطوب خطأ العميل، فرده 400 وليس 500 (عطل في الخادم).
          // هذا الخطأ رقم 2 في جدول 6.5 في التقرير.
          reject(new ValidationError("Malformed JSON body", undefined, ErrorCodes.MALFORMED_JSON));
        }
      } else {
        // ليس JSON: نعطيه للـ handler نصاً كما هو.
        resolve({ raw, parsed: text });
      }
    });
    // انقطع الاتصال في منتصف الإرسال: يُرفض الوعد، ويصل الخطأ إلى onError.
    req.on("error", reject);
  });
}

/**
 * يحذف basePath من أول المسار. يرجع null إن لم يكن المسار تحته.
 * مثال مع basePath = "/v1":  "/v1/products" تعطي "/products"، و "/v1" تعطي "/"، و "/products" تعطي null.
 */
function stripBasePath(pathname: string, basePath: string): string | null {
  if (!basePath) return pathname;
  if (pathname === basePath) return "/";
  if (pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length);
  return null;
}

/** ما يحتاجه createServer ليعمل. يمرره له createCommerceApp في src/app.ts. */
export interface ServerOptions {
  /** كل مسارات الـ API، من الوحدات والإضافات. تُخدم تحت basePath. */
  router: Router;
  /**
   * مسارات النظام: /health و /livez و /readyz و /metrics و /openapi.json.
   * تُخدم دائماً من جذر الخادم، مهما كان basePath، لأن أدوات البنية (موازن الأحمال، Prometheus)
   * تُضبط مرة واحدة ولا يجب أن تتغير مع نسخة الـ API.
   */
  systemRouter?: Router;
  /** بادئة نسخة الـ API، مثل "/v1". الافتراضي "" (بلا بادئة، كما كان الإطار دائماً). */
  basePath?: string;
  /**
   * معالجات تعمل على كل طلب، قبل معالجات المسار، وحتى لو لم يوجد مسار.
   * في المشروع هي [cors, securityHeaders, requestLogger, ...]، والترتيب مهم.
   */
  globalMiddleware: Handler[];
  /** لتسجيل أخطاء الخادم (500) في نافذة الخادم. */
  logger: Logger;
  /** أقصى حجم لجسم الطلب بالبايت. الافتراضي DEFAULT_BODY_LIMIT_BYTES (1 ميغابايت). */
  bodyLimitBytes?: number;
}

/**
 * ينشئ خادم HTTP حقيقياً من Node ويربطه بالـ Router.
 *
 * مع كل طلب يصل:
 *   1. يضيف إلى الرد الدوال المختصرة status و json و send.
 *   2. يعطي الطلب رقماً (req.id) وسجلاً فرعياً (req.log)، ويضع الرقم في ترويسة X-Request-Id.
 *   3. يقسم الرابط: المسار (pathname) يذهب للـ Router، والاستعلام إلى req.query.
 *   4. يسأل مسارات النظام ثم الـ Router عن مسار يطابق الطريقة والمسار.
 *   5. يبني سلسلة المعالجات (chain):
 *        إن وُجد مسار:              globalMiddleware → readBodyStep → route middleware → handler
 *        المسار موجود بطريقة أخرى:  globalMiddleware → MethodNotAllowedError (405)
 *        لا يوجد مسار:              globalMiddleware → NotFoundError (404)
 *   6. يشغّل السلسلة بـ runPipeline (middleware-pipeline.ts).
 *
 * أي خطأ في أي مكان يصل إلى مكان واحد هو onError، سواء رُمي، أو مُرّر بـ next(err)،
 * أو كان مساراً غير موجود، أو جسماً معطوباً. و onError يحوّله إلى رد بـ toErrorResponse
 * (errors.ts). لهذا لا ينهار الخادم أبداً بسبب طلب واحد.
 *
 * لاحظ أن الدالة ترجع الخادم فقط ولا تبدأ الاستماع: listen يحدث لاحقاً في app.ts.
 */
export function createServer({
  router,
  systemRouter,
  basePath = "",
  globalMiddleware,
  logger,
  bodyLimitBytes = DEFAULT_BODY_LIMIT_BYTES,
}: ServerOptions) {
  // createHttpServer هي createServer الأصلية من Node، أعدنا تسميتها عند الاستيراد
  // حتى لا تتعارض مع اسم هذه الدالة. الدالة التي نعطيها لها تُستدعى مع كل طلب،
  // و rawReq و rawRes هما الطلب والرد الخامان من Node.
  return createHttpServer(async (rawReq, rawRes) => {
    const res = enhanceResponse(rawRes);
    // نفس الكائن، نخبر TypeScript فقط أنه AppRequest. حقوله الإضافية نملؤها بعد أسطر.
    const req = rawReq as AppRequest;

    const incomingId = rawReq.headers["x-request-id"];
    req.id = typeof incomingId === "string" && REQUEST_ID_PATTERN.test(incomingId) ? incomingId : randomUUID();
    req.log = logger.child({ requestId: req.id });
    res.setHeader("X-Request-Id", req.id);

    // المكان الوحيد الذي يتحول فيه أي خطأ إلى رد HTTP.
    const onError = (err: unknown): void => {
      // إن كان AppError (مثل NotFoundError) نأخذ رمزه ورسالته،
      // وأي خطأ آخر يصبح 500 برسالة عامة.
      const { statusCode, body, headers } = toErrorResponse(err, req.id);
      // نسجّل أخطاء الخادم (5xx) فقط، لأنها أخطاؤنا نحن. أخطاء 4xx أخطاء العميل.
      // التفاصيل (الرسالة الحقيقية والـ stack) تُكتب في نافذة الخادم فقط ولا تُرسل
      // للعميل أبداً، لأن الـ stack يكشف مسارات الملفات وبنية الكود.
      if (statusCode >= 500) {
        req.log.error("Unhandled error", {
          route: req.route,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      }
      // إن كان الرد قد أُرسل فعلاً (handler أرسل ثم رمى خطأ)، لا نستطيع إرسال رد ثانٍ،
      // فلكل طلب رد واحد فقط.
      if (res.headersSent) return;
      // ترويسات يحملها الخطأ نفسه، مثل Retry-After مع 429، و Allow مع 405.
      for (const [name, value] of Object.entries(headers ?? {})) res.setHeader(name, value);
      // الشكل الموحد لكل الأخطاء: { "error": { "code", "message", "details", "requestId" } }
      res.status(statusCode).json(body);
    };

    try {
      // rawReq.url ليس رابطاً كاملاً، بل ما بعد اسم الخادم، مثل "/products/1?color=red".
      // و new URL يحتاج رابطاً كاملاً، فنعطيه أساساً ثابتاً (لا نستخدم ترويسة Host: قيمتها من العميل).
      const url = new URL(rawReq.url ?? "/", "http://localhost");
      // قيم أولية، حتى لا يجد أي معالج حقلاً غير موجود.
      req.query = url.searchParams;
      req.params = {};
      req.body = undefined;

      // المعالجات العامة تعمل أولاً دائماً: حتى لو لم يوجد مسار، وقبل قراءة الجسم.
      // لهذا قراءة الجسم خطوة داخل السلسلة (readBodyStep)، وليست شيئاً نفعله قبلها.
      // السبب: قبل أي POST بـ JSON إلى موقع آخر، يرسل المتصفح طلب OPTIONS يسأل فيه
      // "هل تسمح لي؟" (اسمه Preflight)، ولا يوجد مسار OPTIONS. لو لم يعمل cors قبل
      // الـ 404 لرفض المتصفح الطلب. هذا الخطأ رقم 1 في جدول 6.5.
      const readBodyStep: Handler = async (_req, _res, next) => {
        try {
          const { raw, parsed } = await readBody(rawReq, bodyLimitBytes);
          req.rawBody = raw;
          req.body = parsed;
        } catch (err) {
          // بعد رفض جسم كبير، بقيته ما زالت في الطريق: نغلق الاتصال بعد الرد بدل أن نقرأها.
          if (err instanceof PayloadTooLargeError) res.setHeader("Connection", "close");
          throw err;
        }
        next();
      };

      const method = rawReq.method ?? "GET";
      // مسارات النظام أولاً (من الجذر)، ثم مسارات الـ API (بعد حذف basePath).
      const apiPath = stripBasePath(url.pathname, basePath);
      let match: RouteMatch | null = systemRouter?.match(method, url.pathname) ?? null;
      let routePrefix = "";
      if (!match && apiPath !== null) {
        match = router.match(method, apiPath);
        routePrefix = basePath;
      }

      let chain: Handler[];
      if (match) {
        req.params = match.params;
        req.route = `${routePrefix}${match.route.path}`;
        // مثال: الطلب POST /carts/c-77/items تصبح سلسلته:
        //   cors → ... → requestLogger → readBodyStep → authenticateOptional → handler
        chain = [...globalMiddleware, readBodyStep, ...match.route.middleware, match.route.handler];
      } else {
        const allowed = [
          ...(systemRouter?.allowedMethods(url.pathname) ?? []),
          ...(apiPath !== null ? router.allowedMethods(apiPath) : []),
        ];
        // لا يوجد مسار، فآخر خطوة ترمي 405 أو 404. لكن المعالجات العامة تعمل قبلها:
        // طلب OPTIONS ينتهي عند cors بـ 204، وأي خطأ آخر يحمل ترويسات CORS.
        chain = [
          ...globalMiddleware,
          () => {
            if (allowed.length > 0) throw new MethodNotAllowedError(method, url.pathname, allowed);
            throw new NotFoundError(`No route for ${method} ${url.pathname}`);
          },
        ];
      }
      // تشغيل السلسلة بالترتيب: كل معالج يستدعي next() لينتقل للتالي، أو يرد فتتوقف.
      runPipeline(chain, req, res, onError);
    } catch (err) {
      // شبكة أمان أخيرة: أي خطأ في التحضير نفسه يذهب إلى نفس المعالج.
      // مثال: رابط فيه ترميز معطوب مثل "/products/%E0%A4%A" يجعل router.match يرمي
      // ValidationError، فيصبح الرد 400 (كان 500 قبل الإصلاح).
      onError(err);
    }
  });
}
