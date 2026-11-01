/**
 * حد المحاولات: يعدّ المحاولات الفاشلة لكل "مفتاح" خلال نافذة زمنية ثابتة.
 * المفتاح مثل "ip:1.2.3.4" (لكل عنوان) أو "email:a@b.ly" (لكل بريد).
 *
 * في المشروع عدّادان (يُنشآن في src/app.ts، ويُستخدمان في src/modules/customers/index.ts):
 *   - الدخول: 10 محاولات فاشلة كل 15 دقيقة، لكل عنوان IP ولكل بريد.
 *   - التسجيل: 5 حسابات في الساعة لكل عنوان IP.
 *
 * العدّادات في الذاكرة (Map)، لا في Redis ولا في قاعدة البيانات، تماشياً مع تصميم
 * "عملية واحدة ونظام تخزين واحد". الثمن: تُصفَّر العدّادات عند إعادة تشغيل الخادم،
 * ولا تعمل عبر عدة نسخ من الخادم.
 *
 * نقطة مهمة: من يستخدمه يفحص retryAfter() قبل أي عمل مكلف (حساب hash كلمة المرور).
 * فبعد حظر المفتاح، تكلف كل محاولة إضافية الخادم شبه لا شيء. هذا ما يمنع سيلاً من
 * محاولات الدخول من إنهاك الخادم (القياس في التقرير: الزمن نزل من 528ms إلى 4ms تقريباً).
 */

export interface LimiterOptions {
  /** عدد الفشل المسموح قبل الحظر، مثل 10. */
  maxFailures: number;
  /** طول النافذة بالثواني، مثل 900 (15 دقيقة). */
  windowSeconds: number;
  /**
   * أقصى عدد مفاتيح نتتبعها. مهاجم يغيّر المفتاح باستمرار (عناوين أو بريدات مختلفة)
   * لا يستطيع بهذا الحد أن يملأ الذاكرة بلا نهاية.
   */
  maxKeys?: number;
}

/** حالة مفتاح واحد. */
interface Entry {
  /** عدد الفشل في هذه النافذة. */
  failures: number;
  /** متى تنتهي هذه النافذة (بالملي ثانية منذ 1970). */
  resetAt: number;
}

/**
 * الواجهة المشتركة لكل أنواع حد المحاولات: في الذاكرة (FailureLimiter أدناه)، أو في PostgreSQL
 * (src/runtime/rate-limit.ts، الافتراضي في التطبيق لأنه يعمل عبر عدة نسخ من الخادم).
 * الدوال قد ترجع قيمة مباشرة أو Promise، والمستدعي يكتب await في الحالتين.
 */
export interface Limiter {
  retryAfter(key: string): number | Promise<number>;
  recordFailure(key: string): void | Promise<void>;
  recordAttempt(key: string): void | Promise<void>;
  reset(key: string): void | Promise<void>;
  /**
   * يسجّل محاولة ويقرر في خطوة واحدة ذرية: يرجع 0 إن كانت المحاولة مسموحة، أو عدد ثواني الانتظار.
   * للحدود التي تعدّ كل محاولة (التسجيل، والشراء، وإنشاء السلال). الفحص ثم التسجيل في خطوتين
   * يسمح لعشرة طلبات متزامنة أن تمر كلها من الفحص قبل أن يُسجَّل أي منها.
   */
  consume(key: string): number | Promise<number>;
}

export class FailureLimiter implements Limiter {
  // المفتاح وحالته. Map تحفظ ترتيب الإضافة، ونستفيد من هذا في prune.
  private readonly entries = new Map<string, Entry>();
  private readonly maxKeys: number;

  /**
   * now دالة الوقت. الافتراضي Date.now، والاختبارات تمرر ساعة وهمية لتجرب
   * "مرور 15 دقيقة" دون انتظار (tests/unit/rate-limiter.test.ts).
   */
  constructor(
    private readonly options: LimiterOptions,
    private readonly now: () => number = Date.now
  ) {
    // 50_000 هي 50000؛ الشرطة السفلية للقراءة فقط.
    this.maxKeys = options.maxKeys ?? 50_000;
  }

  /** حالة المفتاح إن كانت نافذته ما زالت سارية. النافذة المنتهية تُحذف ويُرجع undefined. */
  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry && entry.resetAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /**
   * كم ثانية يجب أن ينتظر هذا المفتاح قبل المحاولة من جديد؟ 0 تعني أنه غير محظور.
   * القيمة تذهب في ترويسة Retry-After مع رد 429.
   */
  retryAfter(key: string): number {
    const entry = this.live(key);
    if (!entry || entry.failures < this.options.maxFailures) return 0;
    // ثانية واحدة على الأقل، مقرّبة للأعلى.
    return Math.max(1, Math.ceil((entry.resetAt - this.now()) / 1000));
  }

  /** يسجل فشلاً. أول فشل يفتح نافذة جديدة تنتهي بعد windowSeconds. */
  recordFailure(key: string): void {
    const entry = this.live(key);
    if (entry) {
      entry.failures++;
      return;
    }
    // مفتاح جديد والجدول ممتلئ: ننظفه أولاً.
    if (this.entries.size >= this.maxKeys) this.prune();
    this.entries.set(key, { failures: 1, resetAt: this.now() + this.options.windowSeconds * 1000 });
  }

  /**
   * نفس العدّاد، لكن لحدود تعدّ كل محاولة لا الفشل فقط، مثل عدد الحسابات المسجلة
   * من نفس العنوان. الاسم المختلف يوضح النية في مكان الاستخدام.
   */
  recordAttempt(key: string): void {
    this.recordFailure(key);
  }

  /** يفحص ثم يسجّل. في الذاكرة الخطوتان متزامنتان (لا await بينهما)، فهما ذريتان أصلاً. */
  consume(key: string): number {
    const wait = this.retryAfter(key);
    if (wait > 0) return wait;
    this.recordAttempt(key);
    return 0;
  }

  /** يمسح عدّاد المفتاح، مثلاً بعد دخول ناجح يُمسح عدّاد البريد (وليس عدّاد العنوان). */
  reset(key: string): void {
    this.entries.delete(key);
  }

  /**
   * ينظف الجدول عندما يمتلئ: يحذف أولاً النوافذ المنتهية، وإن بقي ممتلئاً يحذف
   * أقدم المفاتيح (Map تحفظ ترتيب الإضافة، فأول المفاتيح هي الأقدم).
   */
  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.resetAt <= now) this.entries.delete(key);
    for (const key of this.entries.keys()) {
      if (this.entries.size < this.maxKeys) break;
      this.entries.delete(key);
    }
  }

  /** عدد المفاتيح المتتبعة الآن (تستخدمه الاختبارات). */
  get size(): number {
    return this.entries.size;
  }
}
