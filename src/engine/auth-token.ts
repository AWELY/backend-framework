import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * توكنات دخول موقّعة ولها مدة صلاحية (HMAC-SHA256).
 *
 * نفس فكرة JWT، لكن بخوارزمية واحدة ثابتة ودون مكتبة. الخادم لا يحفظ جدول جلسات:
 *   - التوقيع يثبت أن الخادم هو من أصدر التوكن، فلا يستطيع أحد تزويره دون معرفة السر.
 *   - الحقل exp يحدد متى تنتهي صلاحيته.
 *
 * الشكل:  base64url(JSON المحتوى) + "." + base64url(توقيع الجزء الأول)
 * مثال:   eyJzdWIiOiI...In0.Xk3v9...
 *
 * قيد معروف لهذا النوع (Stateless): لا يمكن إلغاء التوكن قبل انتهاء مدته، فتسجيل الخروج
 * يعني أن يحذفه العميل من عنده. المدة القصيرة (7 أيام افتراضياً، في src/app.ts) تقلل الخطر.
 *
 * ملاحظة: المحتوى ليس مشفّراً، بل مرمّز فقط. أي شخص يستطيع قراءته، لكن لا يستطيع تعديله.
 * لهذا لا نضع فيه إلا رقم الزبون ودوره.
 */

/** محتوى التوكن. */
export interface TokenPayload {
  /** Subject: رقم الزبون (id). */
  sub: string;
  /** الدور، مثل "customer". */
  role: string;
  /** وقت الانتهاء، بالثواني منذ 1970 (Unix epoch). */
  exp: number;
}

/** يحسب توقيع HMAC-SHA256 لنص بالسر. نفس النص ونفس السر يعطيان دائماً نفس التوقيع. */
function sign(body: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

/**
 * يصدر توكناً جديداً. يستدعيها createCommerceApp داخل issueCustomerToken بعد التسجيل أو الدخول.
 * now معامل اختياري للاختبارات فقط: يسمح بتجربة "توكن منتهي" دون انتظار أيام.
 */
export function signToken(
  claims: { sub: string; role: string },
  secret: string,
  ttlSeconds: number,
  now: number = Date.now()
): string {
  // Date.now() بالملي ثانية، و exp بالثواني، لذلك نقسم على 1000.
  const payload: TokenPayload = { ...claims, exp: Math.floor(now / 1000) + ttlSeconds };
  // base64url: مثل base64 لكن بلا رموز "+" و "/" و "=" التي تفسد الروابط والترويسات.
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, secret).toString("base64url")}`;
}

/**
 * يتحقق من التوكن. يرجع المحتوى إن كان التوقيع صحيحاً والمدة لم تنتهِ، وإلا null.
 * يستدعيها middleware/auth.ts مع كل طلب فيه "Authorization: Bearer <token>".
 */
export function verifyToken(token: string, secret: string, now: number = Date.now()): TokenPayload | null {
  // التوكن جزءان بالضبط تفصلهما نقطة. أي شكل آخر مرفوض.
  const [body, signature, ...rest] = token.split(".");
  if (!body || !signature || rest.length > 0) return null;

  // نعيد حساب التوقيع بأنفسنا ونقارنه بالتوقيع المرسل. إن عدّل أحد حرفاً واحداً
  // في المحتوى (مثلاً غيّر role إلى "owner")، يختلف التوقيع فيُرفض التوكن.
  const expected = sign(body, secret);
  const given = Buffer.from(signature, "base64url");
  // timingSafeEqual: مقارنة بزمن ثابت، فلا يكشف زمن الرد كم حرفاً تطابق من التوقيع.
  // (تشترط طولين متساويين، لذلك نفحص الطول أولاً.)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  // التوقيع صحيح: نقرأ المحتوى.
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  // نتأكد من شكل المحتوى قبل الوثوق به.
  const p = payload as Partial<TokenPayload>;
  if (typeof p.sub !== "string" || typeof p.role !== "string" || typeof p.exp !== "number") return null;
  // انتهت المدة؟ (exp بالثواني، و now بالملي ثانية)
  if (p.exp * 1000 <= now) return null;
  return { sub: p.sub, role: p.role, exp: p.exp };
}
