import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * تخزين كلمات المرور بخوارزمية scrypt المدمجة في Node، دون مكتبة مثل bcrypt أو argon2.
 *
 * لماذا scrypt وليس SHA-256 مثلاً؟
 *   - scrypt بطيئة عمداً وتستهلك ذاكرة عمداً. إن سُرقت قاعدة البيانات، تخمين كلمة مرور
 *     واحدة يكلف المهاجم وقتاً وذاكرة كبيرين. SHA-256 سريعة جداً، فيجرّب المهاجم مليارات الكلمات.
 *   - لكل كلمة مرور "ملح" (salt) عشوائي خاص بها، فكلمتا مرور متطابقتان لا تعطيان نفس الـ hash،
 *     ولا تنفع الجداول المحسوبة مسبقاً (Rainbow tables).
 *
 * شكل التخزين في عمود customers.password_hash:
 *   scrypt$N$r$p$<salt بـ base64>$<key بـ base64>
 * الإعدادات (N و r و p) محفوظة مع كل hash، فيمكن رفعها مستقبلاً دون أن تتعطل الكلمات القديمة.
 * كلمة المرور نفسها لا تُحفظ أبداً، ولا يمكن استرجاعها من الـ hash.
 */

/**
 * إعدادات scrypt:
 *   N = 16384 : معامل التكلفة (الوقت والذاكرة). كل مضاعفة له تضاعف كلفة كل محاولة تخمين.
 *   r = 8     : حجم الكتلة، ويؤثر في الذاكرة المطلوبة.
 *   p = 1     : عدد المسارات المتوازية.
 * بهذه القيم يستغرق التحقق نحو 35 ملي ثانية على جهاز الاختبار.
 */
const PARAMS = { N: 16384, r: 8, p: 1 } as const;
/** طول المفتاح الناتج بالبايت. */
const KEY_LENGTH = 64;

/**
 * scrypt في Node تعمل بأسلوب الـ callback القديم، فنغلفها في Promise لنستخدم await معها.
 * تعمل في خيط منفصل داخل Node، فلا توقف الخادم عن خدمة الطلبات الأخرى أثناء الحساب.
 */
function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** يحسب hash لكلمة مرور جديدة (عند التسجيل). */
export async function hashPassword(password: string): Promise<string> {
  // 16 بايت عشوائية لكل كلمة مرور.
  const salt = randomBytes(16);
  // normalize("NFKC"): يوحّد الحروف التي لها أكثر من تمثيل في Unicode، فتعطي نفس النتيجة
  // مهما كانت لوحة المفاتيح أو الجهاز الذي كُتبت منه.
  const key = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, PARAMS);
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64"), key.toString("base64")].join("$");
}

/**
 * يتحقق من كلمة مرور مقابل hash محفوظ (عند الدخول).
 * الطريقة: نعيد الحساب بنفس الملح ونفس الإعدادات المحفوظة، ونقارن النتيجتين.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, keyB64, ...rest] = stored.split("$");
  // أي شكل غير متوقع للـ hash المحفوظ يعني "غير مطابق".
  if (scheme !== "scrypt" || !n || !r || !p || !saltB64 || !keyB64 || rest.length > 0) return false;
  const expected = Buffer.from(keyB64, "base64");
  const actual = await scrypt(password.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  // مقارنة بزمن ثابت: الزمن الذي تستغرقه لا يكشف كم بايتاً تطابق.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// hash وهمي يُحسب مرة واحدة عند أول حاجة إليه، ثم يُعاد استخدامه.
let dummyHash: Promise<string> | undefined;

/**
 * تستهلك نفس وقت التحقق الحقيقي، ثم ترجع false دائماً.
 *
 * يستدعيها الدخول عندما يكون البريد غير مسجل. السبب: لو رد الخادم فوراً على البريد
 * غير الموجود، وبعد 35 ملي ثانية على البريد الموجود، لعرف المهاجم من زمن الرد وحده
 * أي البريدات مسجلة عندنا. هكذا يكون الزمن متقارباً في الحالتين.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  // "??=" تعني: احسبه فقط إن لم يكن محسوباً من قبل.
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  await verifyPassword(password, await dummyHash);
  return false;
}
