import type { Logger } from "../engine/logger";
import type { EventOutbox } from "./outbox";
import type { JobQueue } from "./jobs";

/**
 * العامل في الخلفية: حلقة واحدة في كل نسخة خادم، كل pollIntervalMs (ثانية افتراضياً):
 *   1. يضيف المهام الدورية التي حان وقتها.
 *   2. ينفّذ المهام الجاهزة.
 *   3. يوصل الأحداث الجاهزة من صندوق الصادر.
 * ويكرر 2 و 3 فوراً دون انتظار ما دام يجد عملاً (حتى لا يتأخر طابور طويل).
 *
 * nudge(): "عندي عمل جديد الآن". بعد إتمام شراء، يُطلب دور فوري بدل انتظار الثانية القادمة،
 * فيصل حدث order.created للمستمعين خلال ملي ثوانٍ، دون أن ينتظره رد الشراء.
 *
 * الأخطاء (مثلاً: الجداول غير موجودة لأن migrate لم يُشغَّل) تُسجَّل مرة كل دقيقة على الأكثر،
 * حتى لا تغرق السجل بسطر كل ثانية.
 */
export class BackgroundWorker {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;
  private again = false;
  private lastErrorLog = 0;

  constructor(
    private readonly outbox: EventOutbox<object>,
    private readonly jobs: JobQueue,
    private readonly logger: Logger,
    private readonly pollIntervalMs = 1000
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  /** يوقف الحلقة وينتظر انتهاء الدورة الجارية (لا تُقطع مهمة في منتصفها). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** يطلب دورة فورية (إن كان العامل يعمل). */
  nudge(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.schedule(0);
  }

  /**
   * ينفّذ كل العمل الجاهز الآن حتى لا يبقى شيء، ثم يرجع. للاختبارات والسكربتات:
   * await app.drainBackgroundWork() بعد الشراء، ثم افحص ما فعله المستمع.
   */
  async drain(): Promise<void> {
    await this.running;
    await this.jobs.enqueueDueSchedules();
    for (let i = 0; i < 100; i++) {
      const handled = (await this.jobs.processBatch()) + (await this.outbox.processBatch());
      if (handled === 0) return;
    }
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.tick().finally(() => {
        this.running = undefined;
        const again = this.again;
        this.again = false;
        this.schedule(again ? 0 : this.pollIntervalMs);
      });
    }, delay);
    // unref: المؤقت وحده لا يُبقي البرنامج حياً (مهم للسكربتات والاختبارات).
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      await this.jobs.enqueueDueSchedules();
      for (let i = 0; i < 50 && !this.stopped; i++) {
        const handled = (await this.jobs.processBatch()) + (await this.outbox.processBatch());
        if (handled === 0) break;
      }
    } catch (err) {
      const now = Date.now();
      if (now - this.lastErrorLog > 60_000) {
        this.lastErrorLog = now;
        this.logger.error("Background worker cycle failed", { message: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}
