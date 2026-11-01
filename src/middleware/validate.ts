import type { AppRequest } from "../engine/http/request";
import type { AppResponse } from "../engine/http/response";
import type { NextFunction } from "../engine/router";
import { validate, type Schema } from "../engine/validation";

/**
 * معالج على مستوى المسار: يتحقق من req.body حسب schema قبل أن يصل الطلب إلى الـ handler.
 *
 *   - إن كانت البيانات صحيحة: يستبدل req.body بنتيجة التحقق، وهي كائن جديد فيه حقول
 *     الـ schema فقط، ثم يكمل السلسلة.
 *   - إن لم تكن صحيحة (حقل ناقص، أو قيمة خاطئة، أو حقل غير مسموح): يمرر ValidationError
 *     إلى معالج الأخطاء، فيرد 400 بقائمة كل المشاكل.
 *
 * الاستخدام في مسار (من src/modules/cart/index.ts):
 *   router.post("/carts/:id/items", authenticateOptional, validateBody(addItemSchema), handler)
 * ومع partial: true لطلبات PATCH، حيث كل الحقول اختيارية:
 *   validateBody(productInputSchema, { partial: true })
 *
 * فائدته: الـ handler يثق ببيانات req.body دون أن يكرر الفحص بنفسه.
 */
export function validateBody(schema: Schema, options: { partial?: boolean } = {}) {
  return function validateBodyMiddleware(req: AppRequest, _res: AppResponse, next: NextFunction): void {
    try {
      req.body = options.partial ? validate(schema, req.body, { partial: true }) : validate(schema, req.body);
      next();
    } catch (err) {
      // نمرر الخطأ إلى معالج الأخطاء عبر next(err)، بدل أن نرميه.
      next(err);
    }
  };
}
