import type { AppRequest } from "../engine/http/request";
import type { AppResponse } from "../engine/http/response";
import type { Handler, NextFunction } from "../engine/router";
import { ValidationError, type AppError } from "../engine/errors";
import { validate, validateQuery, type Infer, type InputSpec, type Schema, type FieldIssue } from "../engine/validation";
import { withMeta } from "../engine/route-meta";

/**
 * معالج على مستوى المسار: يتحقق من req.body حسب schema قبل أن يصل الطلب إلى الـ handler.
 *
 *   - إن كانت البيانات صحيحة: يستبدل req.body بنتيجة التحقق، وهي كائن جديد فيه حقول
 *     الـ schema فقط، ثم يكمل السلسلة.
 *   - إن لم تكن صحيحة (حقل ناقص، أو قيمة خاطئة، أو حقل غير مسموح): يمرر ValidationError
 *     إلى معالج الأخطاء، فيرد 400 بقائمة كل المشاكل.
 *
 * باقٍ للتوافق مع المتاجر والإضافات القديمة. للمسارات الجديدة الأفضل withInput أدناه:
 * يعطي الـ handler بيانات بنوعها الصحيح، فلا يحتاج أن يكتب req.body as ... بنفسه.
 */
export function validateBody(schema: Schema, options: { partial?: boolean } = {}) {
  const middleware = function validateBodyMiddleware(req: AppRequest, _res: AppResponse, next: NextFunction): void {
    try {
      req.body = options.partial ? validate(schema, req.body, { partial: true }) : validate(schema, req.body);
      next();
    } catch (err) {
      next(err);
    }
  };
  return withMeta(middleware, { input: { body: schema, partial: options.partial } });
}

// أنواع فقط: ما يستلمه الـ handler من withInput، مستنتجاً من الـ spec نفسه.
type BodyOf<S extends InputSpec> = S["body"] extends Schema
  ? S["partial"] extends true
    ? Partial<Infer<S["body"]>>
    : Infer<S["body"]>
  : undefined;
type QueryOf<S extends InputSpec> = S["query"] extends Schema ? Infer<S["query"]> : undefined;
type ParamsOf<S extends InputSpec> = S["params"] extends Schema ? Infer<S["params"]> : Record<string, string>;

/** المدخلات بعد التحقق، بأنواعها الصحيحة. */
export interface ValidatedInput<S extends InputSpec> {
  body: BodyOf<S>;
  query: QueryOf<S>;
  params: ParamsOf<S>;
}

/**
 * يغلّف handler بتحقق المدخلات الثلاثة (الجسم والاستعلام ومتغيرات المسار)، ويعطيه النتيجة
 * بأنواعها الصحيحة في معامل ثالث. مثال من src/modules/orders/index.ts:
 *
 *   router.patch("/orders/:id/status", authenticate, canWrite,
 *     withInput({ params: idParams, body: statusSchema }, async (req, res, { params, body }) => {
 *       res.json(await service().changeStatus(params.id, body.status));   // body.status نوعه OrderStatus
 *     }));
 *
 * الفائدة فوق validateBody:
 *   - لا تحويل يدوي (as) في الـ handler: TypeScript يعرف النوع من الـ schema نفسه.
 *   - مشاكل الجسم والاستعلام والمسار تُجمع في رد 400 واحد.
 *   - الـ spec يُلصق بالمسار (engine/route-meta.ts)، فيصبح مصدر توثيق OpenAPI تلقائياً.
 *
 * <const S>: يجعل TypeScript يحفظ القيم الحرفية في الـ spec (مثل partial: true) لا النوع العام boolean.
 */
export function withInput<const S extends InputSpec>(
  spec: S,
  handler: (req: AppRequest, res: AppResponse, input: ValidatedInput<S>) => void | Promise<void>
): Handler {
  const wrapped: Handler = async (req, res) => {
    const issues: FieldIssue[] = [];
    // يشغّل فحصاً واحداً، ويجمع مشاكله بدل أن يتوقف عند أول جزء خاطئ.
    const attempt = <T>(fn: () => T, where: string): T | undefined => {
      try {
        return fn();
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        const details = (err as AppError).details;
        if (Array.isArray(details)) issues.push(...(details as FieldIssue[]).map((d) => ({ ...d, field: `${where}${d.field}` })));
        else issues.push({ field: where.replace(/\.$/, "") || "body", message: err.message });
        return undefined;
      }
    };

    // طلب بلا جسم يُعامل كـ {}: فتظهر الحقول المطلوبة الناقصة بأسمائها ("is required")، والمسار الذي
    // كل حقوله اختيارية (مثل استلام المندوب) يعمل دون أن يرسل العميل "{}" بنفسه.
    const input = req.body === undefined ? {} : req.body;
    const body = spec.body
      ? attempt(() => (spec.partial ? validate(spec.body as Schema, input, { partial: true }) : validate(spec.body as Schema, input)), "")
      : undefined;
    const query = spec.query ? attempt(() => validateQuery(spec.query as Schema, req.query), "query.") : undefined;
    const params = spec.params ? attempt(() => validateQuery(spec.params as Schema, req.params), "params.") : req.params;
    if (issues.length > 0) throw new ValidationError("Validation failed", issues);

    if (spec.body) req.body = body;
    await handler(req, res, { body, query, params } as ValidatedInput<S>);
  };
  return withMeta(wrapped, { input: spec, summary: spec.summary, successStatus: spec.successStatus, conditional: spec.conditional });
}
