/**
 * سجل (logger) بمستويات وبصيغتين، ودون أي اعتمادية.
 *
 * لماذا لم نستخدم مكتبة مثل pino أو winston؟ قاعدة المشروع "اعتماديات قليلة، وكل واحدة
 * لها مبرر" تنطبق هنا أيضاً. ما يحتاجه الإنتاج فعلاً أربعة أشياء، وكلها هنا في أسطر قليلة:
 *
 *   1. صيغة JSON (format: "json"): سطر JSON واحد لكل رسالة، تقرؤه أدوات جمع السجلات
 *      (Loki، CloudWatch، Datadog...) وتبحث فيه بالحقول: level=error AND requestId=...
 *      والصيغة المقروءة (format: "pretty") تبقى الافتراضية للتطوير:
 *        [2026-10-05T12:25:40.268Z] INFO GET /products/2 200 1ms
 *   2. سجلات فرعية (child): logger.child({ requestId }) يرجع سجلاً يضيف requestId إلى كل سطر.
 *      الخادم يعطي كل طلب سجلاً فرعياً (req.log)، فكل سطر يكتبه الطلب يحمل رقمه.
 *   3. الحجب (Redaction): أي حقل اسمه يشبه password أو token أو secret أو authorization
 *      يُكتب "[REDACTED]"، حتى لو مرره مطوّر إلى السجل بالخطأ.
 *   4. الأخطاء: كائن Error يتحول إلى { name, message, stack } بدل {} الفارغ الذي يعطيه JSON.stringify.
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

/** أسماء الحقول التي تُحجب قيمتها دائماً. */
const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|api[-_]?key|cookie|signature/i;

export type LogFormat = "pretty" | "json";

export interface LoggerOptions {
  format?: LogFormat;
  /** حقول تُضاف إلى كل سطر، مثل { requestId }. */
  bindings?: Record<string, unknown>;
  /**
   * أين يُكتب السطر. الافتراضي الطرفية (console.error للأخطاء، console.log لغيرها).
   * الاختبارات تمرر دالة تجمع الأسطر لتفحصها.
   */
  sink?: (level: LogLevel, line: string) => void;
}

/** يحوّل أي قيمة إلى شكل آمن للكتابة: يحجب الحقول الحساسة، ويفك كائنات Error، ويوقف التداخل العميق. */
export function redactSensitive(value: unknown, depth = 0): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (value === null || typeof value !== "object") return value;
  if (depth > 6) return "[Truncated]";
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (Array.isArray(value)) return value.map((v) => redactSensitive(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactSensitive(v, depth + 1);
  }
  return out;
}

function defaultSink(level: LogLevel, line: string): void {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export class Logger {
  /** الصيغة الحالية، تقرؤها requestLogger لتقرر هل تضيف الحقول المنفصلة. */
  readonly format: LogFormat;
  private readonly bindings: Record<string, unknown>;
  private readonly sink: (level: LogLevel, line: string) => void;

  constructor(
    private readonly minLevel: LogLevel = "info",
    options: LoggerOptions = {}
  ) {
    this.format = options.format ?? "pretty";
    this.bindings = options.bindings ?? {};
    this.sink = options.sink ?? defaultSink;
  }

  /** سجل فرعي يضيف bindings إلى كل سطر، بنفس المستوى والصيغة والوجهة. */
  child(bindings: Record<string, unknown>): Logger {
    return new Logger(this.minLevel, {
      format: this.format,
      bindings: { ...this.bindings, ...bindings },
      sink: this.sink,
    });
  }

  /** هل يُكتب هذا المستوى؟ مفيدة لتجنب بناء رسالة مكلفة لن تُطبع. */
  isEnabled(level: LogLevel): boolean {
    return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[this.minLevel];
  }

  /** يكتب سطراً واحداً إن كان المستوى مسموحاً. meta بيانات إضافية (مثل الـ stack أو رقم الطلب). */
  private write(level: LogLevel, message: string, meta?: unknown): void {
    if (!this.isEnabled(level)) return;
    const time = new Date().toISOString();
    const safeMeta = meta === undefined ? undefined : redactSensitive(meta);

    if (this.format === "json") {
      // الحقول الثابتة أولاً، ثم bindings، ثم meta (إن كانت كائناً تُفرد حقوله، وإلا تُوضع في "meta").
      const extra =
        safeMeta !== null && typeof safeMeta === "object" && !Array.isArray(safeMeta)
          ? (safeMeta as Record<string, unknown>)
          : safeMeta === undefined
            ? {}
            : { meta: safeMeta };
      this.sink(level, JSON.stringify({ time, level, msg: message, ...redactSensitive(this.bindings) as object, ...extra }));
      return;
    }

    let line = `[${time}] ${level.toUpperCase()} ${message}`;
    // في الصيغة المقروءة: رقم الطلب مختصراً في آخر السطر، ثم meta كما هي.
    const requestId = this.bindings.requestId;
    if (typeof requestId === "string") line += ` req=${requestId.slice(0, 8)}`;
    if (typeof safeMeta === "string") line += ` ${safeMeta}`;
    else if (safeMeta !== null && typeof safeMeta === "object" && !Array.isArray(safeMeta)) {
      // الـ stack في أسطر خاصة به بعد السطر الأساسي، ليبقى مقروءاً في الطرفية.
      const { stack, ...rest } = safeMeta as Record<string, unknown>;
      if (Object.keys(rest).length > 0) line += ` ${JSON.stringify(rest)}`;
      if (typeof stack === "string") line += `\n${stack}`;
    } else if (safeMeta !== undefined) line += ` ${JSON.stringify(safeMeta)}`;
    this.sink(level, line);
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
