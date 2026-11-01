/**
 * سجل (logger) بسيط بمستويات، ودون أي اعتمادية.
 *
 * لماذا لم نستخدم مكتبة مثل pino أو winston؟ قاعدة المشروع "اعتماديات قليلة، وكل واحدة
 * لها مبرر" تنطبق هنا أيضاً: سجل يكتب في الطرفية مع الوقت وتصفية حسب المستوى يكفي
 * لحجم هذا المشروع، والمكتبة ستكون وزناً بلا مبرر.
 *
 * شكل السطر:  [2026-10-05T12:25:40.268Z] INFO GET /products/2 200 1ms
 */

import type { LogLevel } from "./config";

/**
 * وزن كل مستوى. السجل يطبع فقط الرسائل التي وزنها >= وزن المستوى الأدنى المختار.
 * مثال: مع minLevel = "info" تُطبع info و warn و error، وتُهمل debug.
 */
const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  // "private readonly minLevel" داخل الـ constructor تعرّف الخاصية وتضبطها في سطر واحد.
  constructor(private readonly minLevel: LogLevel = "info") {}

  /** يكتب سطراً واحداً إن كان المستوى مسموحاً. meta بيانات إضافية تُطبع بعد السطر (مثل الـ stack). */
  private write(level: LogLevel, message: string, meta?: unknown): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.minLevel]) return;
    const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
    // الأخطاء إلى console.error والتحذيرات إلى console.warn، فتظهر في مجرى الأخطاء (stderr)،
    // والباقي إلى console.log (stdout).
    const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    if (meta !== undefined) sink(line, meta);
    else sink(line);
  }

  /** تفاصيل للتطوير فقط. */
  debug(message: string, meta?: unknown): void {
    this.write("debug", message, meta);
  }
  /** معلومة عادية، مثل كل طلب في requestLogger. */
  info(message: string, meta?: unknown): void {
    this.write("info", message, meta);
  }
  /** شيء غير طبيعي لم يوقف العمل، مثل إضافة رمت خطأ داخل مستمع حدث. */
  warn(message: string, meta?: unknown): void {
    this.write("warn", message, meta);
  }
  /** خطأ حقيقي في الخادم، مثل خطأ 500 في server.ts. */
  error(message: string, meta?: unknown): void {
    this.write("error", message, meta);
  }
}
