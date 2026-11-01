import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import type { Router, Handler } from "../router";
import type { AppRequest } from "./request";
import { enhanceResponse } from "./response";
import { runPipeline } from "../middleware-pipeline";
import type { Logger } from "../logger";
import { NotFoundError, ValidationError, toErrorResponse } from "../errors";

/**
 * يقرأ جسم الطلب كاملاً ويحوّله إلى قيمة JavaScript.
 *
 * الجسم لا يصل دفعة واحدة، بل عبر الشبكة على قطع (chunks)، حوالي 64 كيلوبايت لكل قطعة.
 * Node يخبرنا بحدث "data" مع كل قطعة، وبحدث "end" عندما يكتمل الجسم، ولا يقف منتظراً
 * بينهما (يخدم طلبات أخرى في الأثناء). نحوّل هذه الأحداث إلى Promise حتى نكتب في
 * مكان الاستخدام سطراً واحداً:
 *   req.body = await readBody(rawReq);
 *
 * النتيجة:
 *   - إن لم يوجد جسم: undefined
 *   - إن كان Content-Type فيه application/json: كائن (بـ JSON.parse)
 *   - إن كان JSON معطوباً: ValidationError، أي رد 400
 *   - أي نوع آخر: النص كما هو
 *
 * قيد معروف: لا يوجد حد لحجم الجسم، فالقطع تُجمع كلها في الذاكرة.
 * الحل لو أضفناه: نعدّ البايتات في حدث "data"، ونرد 413 إن تجاوزت حداً معيناً.
 */
function readBody(req: IncomingMessage): Promise<unknown> {
  // resolve(قيمة) معناها "وصلت النتيجة"، و reject(خطأ) معناها "فشل".
  return new Promise((resolve, reject) => {
    // Buffer تعني بايتات خام. نجمع القطع كما هي، دون تحويلها نصاً الآن.
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      // لم تصل أي قطعة: طلب بلا جسم، مثل GET.
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      // ندمج القطع أولاً ثم نحوّلها نصاً، والترتيب مهم: الحرف العربي بايتان في UTF-8،
      // وقد يقع نصفه في آخر قطعة ونصفه الآخر في أول التي تليها.
      // لو حوّلنا كل قطعة نصاً وحدها لانكسر الحرف.
      const raw = Buffer.concat(chunks).toString("utf8");
      // نقرأ الجسم كـ JSON فقط إن قال العميل إنه JSON. نستخدم includes وليس ===
      // لأن الترويسة قد تكون "application/json; charset=utf-8".
      // و ?? "" تعطي نصاً فارغاً إن لم تُرسل الترويسة أصلاً.
      const contentType = req.headers["content-type"] ?? "";
      if (contentType.includes("application/json")) {
        try {
          resolve(raw.length ? JSON.parse(raw) : undefined);
        } catch {
          // JSON المعطوب خطأ العميل، فرده 400 وليس 500 (عطل في الخادم).
          // قبل هذا الإصلاح كان SyntaxError يصل كما هو إلى toErrorResponse فيصبح 500.
          // هذا الخطأ رقم 2 في جدول 6.5 في التقرير.
          reject(new ValidationError("Malformed JSON body"));
        }
      } else {
        // ليس JSON: نعطيه للـ handler نصاً كما هو.
        resolve(raw);
      }
    });
    // انقطع الاتصال في منتصف الإرسال: يُرفض الوعد، ويصل الخطأ إلى onError.
    req.on("error", reject);
  });
}

/** ما يحتاجه createServer ليعمل. يمرره له createCommerceApp في src/app.ts. */
export interface ServerOptions {
  /** كل المسارات المسجلة، من الوحدات والإضافات. */
  router: Router;
  /**
   * معالجات تعمل على كل طلب، قبل معالجات المسار، وحتى لو لم يوجد مسار.
   * في المشروع هي [cors, requestLogger]، والترتيب مهم.
   */
  globalMiddleware: Handler[];
  /** لتسجيل أخطاء الخادم (500) في نافذة الخادم. */
  logger: Logger;
}

/**
 * ينشئ خادم HTTP حقيقياً من Node ويربطه بالـ Router.
 *
 * مع كل طلب يصل:
 *   1. يضيف إلى الرد الدوال المختصرة status و json و send.
 *   2. يقسم الرابط: المسار (pathname) يذهب للـ Router، والاستعلام إلى req.query.
 *   3. يسأل الـ Router عن مسار يطابق الطريقة والمسار.
 *   4. يبني سلسلة المعالجات (chain):
 *        إن وُجد مسار:  globalMiddleware → readBodyStep → route middleware → handler
 *        إن لم يوجد:    globalMiddleware → NotFoundError (404)
 *   5. يشغّل السلسلة بـ runPipeline (middleware-pipeline.ts).
 *
 * أي خطأ في أي مكان يصل إلى مكان واحد هو onError، سواء رُمي، أو مُرّر بـ next(err)،
 * أو كان مساراً غير موجود، أو جسماً معطوباً. و onError يحوّله إلى رد بـ toErrorResponse
 * (errors.ts). لهذا لا ينهار الخادم أبداً بسبب طلب واحد.
 *
 * لاحظ أن الدالة ترجع الخادم فقط ولا تبدأ الاستماع: listen يحدث لاحقاً في app.ts.
 */
export function createServer({ router, globalMiddleware, logger }: ServerOptions) {
  // createHttpServer هي createServer الأصلية من Node، أعدنا تسميتها عند الاستيراد
  // حتى لا تتعارض مع اسم هذه الدالة. الدالة التي نعطيها لها تُستدعى مع كل طلب،
  // و rawReq و rawRes هما الطلب والرد الخامان من Node.
  return createHttpServer(async (rawReq, rawRes) => {
    const res = enhanceResponse(rawRes);
    // نفس الكائن، نخبر TypeScript فقط أنه AppRequest. حقوله الإضافية نملؤها بعد أسطر.
    const req = rawReq as AppRequest;

    // المكان الوحيد الذي يتحول فيه أي خطأ إلى رد HTTP.
    const onError = (err: unknown): void => {
      // إن كان AppError (مثل NotFoundError) نأخذ رمزه ورسالته،
      // وأي خطأ آخر يصبح 500 برسالة عامة.
      const { statusCode, body, headers } = toErrorResponse(err);
      // نسجّل أخطاء الخادم (500) فقط، لأنها أخطاؤنا نحن. أخطاء 4xx أخطاء العميل.
      // التفاصيل (الرسالة الحقيقية والـ stack) تُكتب في نافذة الخادم فقط ولا تُرسل
      // للعميل أبداً، لأن الـ stack يكشف مسارات الملفات وبنية الكود.
      if (statusCode >= 500) {
        logger.error("Unhandled error", {
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      }
      // إن كان الرد قد أُرسل فعلاً (handler أرسل ثم رمى خطأ)، لا نستطيع إرسال رد ثانٍ،
      // فلكل طلب رد واحد فقط.
      if (res.headersSent) return;
      // ترويسات يحملها الخطأ نفسه، مثل Retry-After مع 429 (TooManyRequestsError).
      for (const [name, value] of Object.entries(headers ?? {})) res.setHeader(name, value);
      // الشكل الموحد لكل الأخطاء: { "error": { "message": ..., "details": ... } }
      res.status(statusCode).json(body);
    };

    try {
      // rawReq.url ليس رابطاً كاملاً، بل ما بعد اسم الخادم، مثل "/products/1?color=red".
      // و new URL يحتاج رابطاً كاملاً، فنعطيه أساساً مثل "http://localhost:3000". النتيجة:
      //   url.pathname     = "/products/1"  للـ Router، بدون الاستعلام، ويبقى مرمّزاً
      //   url.searchParams = color=red
      const url = new URL(rawReq.url ?? "/", `http://${rawReq.headers.host ?? "localhost"}`);
      // قيم أولية، حتى لا يجد أي معالج حقلاً غير موجود.
      req.query = url.searchParams;
      req.params = {};
      req.body = undefined;

      // المعالجات العامة تعمل أولاً دائماً: حتى لو لم يوجد مسار، وقبل قراءة الجسم.
      // لهذا قراءة الجسم خطوة داخل السلسلة (readBodyStep)، وليست شيئاً نفعله قبلها.
      // السبب: قبل أي POST بـ JSON إلى موقع آخر، يرسل المتصفح طلب OPTIONS يسأل فيه
      // "هل تسمح لي؟" (اسمه Preflight)، ولا يوجد مسار OPTIONS. لو لم يعمل cors قبل
      // الـ 404 لرفض المتصفح الطلب، ولما استطاع الموقع حتى قراءة رسائل الخطأ
      // (404، أو JSON معطوب) لغياب ترويسات CORS عنها.
      // هذا الخطأ رقم 1 في جدول 6.5: الإضافة إلى السلة لم تكن تعمل من الموقع.
      const readBodyStep: Handler = async (_req, _res, next) => {
        // إن كان JSON معطوباً، يرمي await الخطأ، و runPipeline يلتقطه ويرسله إلى onError.
        req.body = await readBody(rawReq);
        next();
      };
      // نسأل الـ Router: يرجع { route, params } إن وُجد مسار، وإلا null.
      const match = router.match(rawReq.method ?? "GET", url.pathname);
      // مثال: الطلب POST /carts/c-77/items تصبح سلسلته 6 خطوات:
      //   cors → requestLogger → readBodyStep → authenticateOptional → validateBody → handler
      // و "..." (Spread) تفرد عناصر مصفوفة داخل المصفوفة الجديدة.
      const chain: Handler[] = match
        ? [...globalMiddleware, readBodyStep, ...match.route.middleware, match.route.handler]
        : [
            ...globalMiddleware,
            // لا يوجد مسار، فآخر خطوة ترمي 404. لكن المعالجات العامة تعمل قبلها:
            // طلب OPTIONS ينتهي عند cors بـ 204، وأي 404 آخر يحمل ترويسات CORS.
            () => {
              throw new NotFoundError(`No route for ${rawReq.method} ${url.pathname}`);
            },
          ];
      if (match) req.params = match.params;
      // تشغيل السلسلة بالترتيب: كل معالج يستدعي next() لينتقل للتالي، أو يرد فتتوقف.
      runPipeline(chain, req, res, onError);
    } catch (err) {
      // شبكة أمان أخيرة: أي خطأ في التحضير نفسه يذهب إلى نفس المعالج.
      // مثال: رابط فيه ترميز معطوب مثل "/products/%E0%A4%A" يجعل router.match يرمي
      // (يصبح اليوم 500، والأصح 400).
      onError(err);
    }
  });
}
