/**
 * مقاييس بصيغة Prometheus، دون مكتبة (مثل prom-client).
 *
 * المقياس رقم يتغير مع الوقت، تقرؤه أداة مراقبة (Prometheus) كل بضع ثوانٍ من GET /metrics،
 * وترسم منه لوحات وتطلق تنبيهات، مثل "نسبة أخطاء 5xx تجاوزت 1% خلال 5 دقائق".
 * ثلاثة أنواع تكفي لكل ما نحتاجه:
 *
 *   Counter   عدّاد يزيد فقط، مثل عدد الطلبات. Prometheus يحسب منه المعدل في الثانية.
 *   Histogram توزيع قيم في "سلال" (buckets)، مثل مدة الطلبات: كم طلباً أخذ أقل من 50ms؟ أقل من 100ms؟
 *             منه تُحسب النسب المئوية: "99% من الطلبات تنتهي في أقل من 250ms".
 *   Gauge     قيمة تُقرأ لحظة الطلب، مثل عدد اتصالات القاعدة المشغولة الآن.
 *
 * التسميات (labels) تقسم المقياس، مثل { method: "GET", route: "/products/:id", status: "200" }.
 * قاعدة مهمة: التسمية تأخذ قيماً محدودة فقط. لهذا نستخدم المسار المسجّل ("/products/:id") لا الرابط
 * الحقيقي ("/products/5f2c...")، وإلا صار لكل منتج سلسلة خاصة وانفجرت ذاكرة Prometheus.
 *
 * الصيغة النصية الناتجة (render) هي "text exposition format" التي يفهمها Prometheus:
 *   # HELP http_requests_total Requests served
 *   # TYPE http_requests_total counter
 *   http_requests_total{method="GET",route="/products",status="200"} 42
 */

export type Labels = Record<string, string>;

/** يهرّب قيمة التسمية: الشرطة المائلة العكسية، وعلامة التنصيص، والسطر الجديد. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** يحوّل التسميات إلى {a="1",b="2"} بترتيب ثابت (مفتاح السلسلة نفسه يعتمد على هذا الترتيب). */
function formatLabels(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return `{${keys.map((k) => `${k}="${escapeLabel(labels[k] as string)}"`).join(",")}}`;
}

/** عدّاد يزيد فقط. */
export class Counter {
  private readonly series = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string
  ) {}

  inc(labels: Labels = {}, value = 1): void {
    const key = formatLabels(labels);
    this.series.set(key, (this.series.get(key) ?? 0) + value);
  }

  /** القيمة الحالية لسلسلة واحدة (تستخدمها الاختبارات). */
  get(labels: Labels = {}): number {
    return this.series.get(formatLabels(labels)) ?? 0;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, value] of this.series) lines.push(`${this.name}${key} ${value}`);
    return lines.join("\n");
  }
}

/** السلال الافتراضية لمدة الطلبات، بالثواني: من 5 ملي ثانية حتى 10 ثوانٍ. */
export const DEFAULT_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface HistogramSeries {
  labels: Labels;
  /** عدد القيم في كل سلة (القيمة <= حد السلة)، بنفس ترتيب buckets. */
  counts: number[];
  sum: number;
  count: number;
}

/** توزيع قيم في سلال. */
export class Histogram {
  private readonly series = new Map<string, HistogramSeries>();
  constructor(
    readonly name: string,
    readonly help: string,
    private readonly buckets: readonly number[] = DEFAULT_DURATION_BUCKETS
  ) {}

  observe(labels: Labels, value: number): void {
    const key = formatLabels(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    this.buckets.forEach((bound, i) => {
      if (value <= bound) s.counts[i] = (s.counts[i] ?? 0) + 1;
    });
    s.sum += value;
    s.count += 1;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.series.values()) {
      this.buckets.forEach((bound, i) => {
        lines.push(`${this.name}_bucket${formatLabels({ ...s.labels, le: String(bound) })} ${s.counts[i]}`);
      });
      lines.push(`${this.name}_bucket${formatLabels({ ...s.labels, le: "+Inf" })} ${s.count}`);
      lines.push(`${this.name}_sum${formatLabels(s.labels)} ${s.sum}`);
      lines.push(`${this.name}_count${formatLabels(s.labels)} ${s.count}`);
    }
    return lines.join("\n");
  }
}

/** قيمة تُقرأ عند كل طلب للمقاييس، من دالة collect. */
export class Gauge {
  constructor(
    readonly name: string,
    readonly help: string,
    private readonly collect: () => number | Array<{ labels?: Labels; value: number }>
  ) {}

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    const result = this.collect();
    const values = typeof result === "number" ? [{ value: result }] : result;
    for (const { labels, value } of values) lines.push(`${this.name}${formatLabels(labels ?? {})} ${value}`);
    return lines.join("\n");
  }
}

/** سجل كل المقاييس. الاسم فريد: طلب نفس الاسم مرتين يرجع نفس المقياس. */
export class MetricsRegistry {
  private readonly metrics = new Map<string, Counter | Histogram | Gauge>();

  private getOrCreate<M extends Counter | Histogram | Gauge>(name: string, create: () => M): M {
    const existing = this.metrics.get(name);
    if (existing) return existing as M;
    const metric = create();
    this.metrics.set(name, metric);
    return metric;
  }

  counter(name: string, help: string): Counter {
    return this.getOrCreate(name, () => new Counter(name, help));
  }

  histogram(name: string, help: string, buckets?: readonly number[]): Histogram {
    return this.getOrCreate(name, () => new Histogram(name, help, buckets));
  }

  gauge(name: string, help: string, collect: () => number | Array<{ labels?: Labels; value: number }>): Gauge {
    return this.getOrCreate(name, () => new Gauge(name, help, collect));
  }

  /** كل المقاييس بالصيغة النصية التي يقرؤها Prometheus. */
  render(): string {
    return `${[...this.metrics.values()].map((m) => m.render()).join("\n")}\n`;
  }
}
