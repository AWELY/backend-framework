import type { AppRequest } from "./http/request";
import type { AppResponse } from "./http/response";
import type { Handler, NextFunction } from "./router";

/**
 * يشغّل قائمة معالجات بالترتيب، بنفس أسلوب Express (نمط Chain of Responsibility):
 *   - كل معالج يستلم (req, res, next).
 *   - يستدعي next() لينتقل إلى المعالج التالي.
 *   - أو يستدعي next(err) ليقفز مباشرة إلى onError.
 *   - أو يرسل الرد بنفسه ولا يستدعي next، فتتوقف السلسلة (مثل cors مع طلب OPTIONS).
 *
 * المعالج قد يكون دالة عادية أو async. في الحالتين أي خطأ يُرمى، أو وعد يُرفض، يُلتقط
 * ويُرسل إلى onError، بدل أن يوقف البرنامج كله.
 *
 * مثال: السلسلة [cors, requestLogger, readBodyStep, authenticate, validateBody, handler]
 *   next() الأولى تشغّل cors، و cors تستدعي next() فيعمل requestLogger، وهكذا حتى الـ handler.
 *   إن أوقف authenticate السلسلة بخطأ 401 (next(err))، لا يعمل validateBody ولا الـ handler.
 */
export function runPipeline(
  handlers: Handler[],
  req: AppRequest,
  res: AppResponse,
  onError: (err: unknown) => void
): void {
  // رقم المعالج التالي. الدالة next "تتذكره" بين الاستدعاءات (Closure).
  let index = 0;

  const next: NextFunction = (err?: unknown) => {
    // next(err): توقف السلسلة، والخطأ يذهب لمعالج الأخطاء.
    if (err !== undefined) {
      onError(err);
      return;
    }
    // نأخذ المعالج الحالي ثم نزيد الرقم (index++ تعطي القيمة قبل الزيادة).
    const handler = handlers[index++];
    // انتهت القائمة: لا شيء نفعله.
    if (!handler) return;
    try {
      const result = handler(req, res, next);
      // معالج async يرجع Promise: إن رُفض لاحقاً (خطأ بعد await)، نلتقطه هنا.
      // بدون هذا السطر يصبح الخطأ "Unhandled rejection" خارج سيطرتنا.
      if (result instanceof Promise) {
        result.catch(onError);
      }
    } catch (syncErr) {
      // معالج عادي (غير async) رمى خطأ مباشرة.
      onError(syncErr);
    }
  };

  // نبدأ السلسلة بتشغيل أول معالج.
  next();
}
