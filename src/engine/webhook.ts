import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * توقيع الـ webhooks والتحقق منها.
 *
 * الـ webhook: بوابة الدفع تستدعي خادمنا لتخبرنا "الطلب X دُفع". أي أحد يعرف الرابط يستطيع
 * إرسال نفس الطلب مزوراً، فتوقّع البوابة كل طلب بسر مشترك بيننا وبينها (HMAC-SHA256)،
 * ونحن نعيد حساب التوقيع على البايتات الخام (req.rawBody) ونقارن.
 *
 * الشكل (مثل ما تستخدمه Stripe وغيرها):  t=<الوقت بالثواني>,v1=<التوقيع بالـ hex>
 * والتوقيع محسوب على "<الوقت>.<الجسم الخام>". لماذا الوقت داخل التوقيع؟ لمنع إعادة الإرسال
 * (Replay): مهاجم سجّل طلباً صحيحاً قديماً لا يستطيع إعادته بعد مرور toleranceSeconds،
 * ولا يستطيع تغيير الوقت دون أن يكسر التوقيع.
 *
 * يمكن تمرير عدة أسرار (secrets) أثناء تغيير السر: الجديد والقديم يُقبلان معاً لفترة.
 *
 * البوابات التي تستخدم شكلاً مختلفاً تستطيع استخدام hmacSha256Hex و safeEqual مباشرة.
 */

/** توقيع HMAC-SHA256 بصيغة hex. */
export function hmacSha256Hex(secret: string, payload: string | Buffer): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** مقارنة نصين بزمن ثابت: لا يكشف زمن المقارنة عند أي حرف اختلف النصان (Timing attack). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** يصنع ترويسة التوقيع لجسم. تستخدمه البوابات الوهمية في الاختبارات، ومن يرسل webhooks بنفسه. */
export function signWebhookPayload(payload: string | Buffer, secret: string, now: number = Date.now()): string {
  const t = Math.floor(now / 1000);
  const body = typeof payload === "string" ? payload : payload.toString("utf8");
  return `t=${t},v1=${hmacSha256Hex(secret, `${t}.${body}`)}`;
}

export interface VerifyWebhookOptions {
  /** الجسم الخام كما وصل (req.rawBody). */
  payload: string | Buffer | undefined;
  /** قيمة ترويسة التوقيع، مثل "t=1730000000,v1=ab12...". */
  header: string | string[] | undefined;
  /** السر، أو عدة أسرار أثناء التغيير. */
  secret: string | readonly string[];
  /** أقصى عمر مقبول للتوقيع بالثواني. الافتراضي 5 دقائق. */
  toleranceSeconds?: number;
  now?: number;
}

/** هل التوقيع صحيح وحديث؟ يرجع false (لا يرمي) لأي مدخل معطوب. */
export function verifyWebhookSignature(options: VerifyWebhookOptions): boolean {
  const { payload, header, toleranceSeconds = 300, now = Date.now() } = options;
  if (payload === undefined || typeof header !== "string") return false;
  const parts = new Map<string, string[]>();
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2).map((s) => s.trim());
    if (!key || !value) continue;
    parts.set(key, [...(parts.get(key) ?? []), value]);
  }
  const t = Number(parts.get("t")?.[0]);
  const signatures = parts.get("v1") ?? [];
  if (!Number.isInteger(t) || signatures.length === 0) return false;
  if (Math.abs(Math.floor(now / 1000) - t) > toleranceSeconds) return false;

  const body = typeof payload === "string" ? payload : payload.toString("utf8");
  const secrets = typeof options.secret === "string" ? [options.secret] : options.secret;
  return secrets.some((secret) => {
    const expected = hmacSha256Hex(secret, `${t}.${body}`);
    return signatures.some((sig) => safeEqual(sig, expected));
  });
}
