import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * توكنات دخول موقّعة ولها مدة صلاحية (HMAC-SHA256).
 *
 * نفس فكرة JWT، لكن بخوارزمية واحدة ثابتة ودون مكتبة:
 *   - التوقيع يثبت أن الخادم هو من أصدر التوكن، فلا يستطيع أحد تزويره دون معرفة السر.
 *   - الحقل exp يحدد متى تنتهي صلاحيته.
 *
 * الشكل:  base64url(JSON المحتوى) + "." + base64url(توقيع الجزء الأول)
 * مثال:   eyJzdWIiOiI...In0.Xk3v9...
 *
 * الإلغاء: التوكن يحمل رقم جلسة (sid) محفوظة في جدول auth_sessions (src/runtime/sessions.ts).
 * المصادقة تتأكد مع كل طلب أن الجلسة ما زالت سارية، فتسجيل الخروج، أو تغيير كلمة المرور، أو
 * إيقاف حساب موظف، يلغي التوكن فوراً، لا بعد انتهاء مدته. القرار في docs/adr/0006-server-side-sessions.md.
 *
 * تغيير السر (Rotation): verifyToken يقبل عدة أسرار. الأول يوقّع التوكنات الجديدة، والباقي أسرار
 * قديمة ما زالت تُقبل، فلا يخرج كل الزبائن لحظة تغيير السر.
 *
 * ملاحظة: المحتوى ليس مشفّراً، بل مرمّز فقط. أي شخص يستطيع قراءته، لكن لا يستطيع تعديله.
 * لهذا لا نضع فيه إلا الأرقام والدور.
 */

/** محتوى التوكن. */
export interface TokenPayload {
  /** Subject: رقم الزبون أو الموظف (id). */
  sub: string;
  /** الدور وقت الإصدار، مثل "customer". للموظف يُقرأ الدور الحالي من القاعدة عند كل طلب. */
  role: string;
  /** وقت الانتهاء، بالثواني منذ 1970 (Unix epoch). */
  exp: number;
  /** رقم الجلسة في auth_sessions. */
  sid?: string;
  /** نوع صاحب التوكن (Principal type). */
  pt?: "customer" | "staff";
}

/** يحسب توقيع HMAC-SHA256 لنص بالسر. نفس النص ونفس السر يعطيان دائماً نفس التوقيع. */
function sign(body: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

/**
 * يصدر توكناً جديداً. يستدعيها createCommerceApp عند إنشاء جلسة دخول.
 * now معامل اختياري للاختبارات فقط: يسمح بتجربة "توكن منتهي" دون انتظار أيام.
 */
export function signToken(
  claims: { sub: string; role: string; sid?: string; pt?: "customer" | "staff" },
  secret: string,
  ttlSeconds: number,
  now: number = Date.now()
): string {
  const payload: TokenPayload = { ...claims, exp: Math.floor(now / 1000) + ttlSeconds };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, secret).toString("base64url")}`;
}

/**
 * يتحقق من التوكن. يرجع المحتوى إن كان التوقيع صحيحاً (بأي سر من secret) والمدة لم تنتهِ، وإلا null.
 * يستدعيها middleware/auth.ts مع كل طلب فيه "Authorization: Bearer <token>".
 */
export function verifyToken(
  token: string,
  secret: string | readonly string[],
  now: number = Date.now()
): TokenPayload | null {
  const [body, signature, ...rest] = token.split(".");
  if (!body || !signature || rest.length > 0) return null;

  const given = Buffer.from(signature, "base64url");
  const secrets = typeof secret === "string" ? [secret] : secret;
  const valid = secrets.some((s) => {
    const expected = sign(body, s);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!valid) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const p = payload as Partial<TokenPayload>;
  if (typeof p.sub !== "string" || typeof p.role !== "string" || typeof p.exp !== "number") return null;
  if (p.exp * 1000 <= now) return null;
  const result: TokenPayload = { sub: p.sub, role: p.role, exp: p.exp };
  if (typeof p.sid === "string") result.sid = p.sid;
  if (p.pt === "customer" || p.pt === "staff") result.pt = p.pt;
  return result;
}
