"use strict";

/**
 * الخادم الذي يُقاس أداؤه. يشغّله bench/run.js كعملية منفصلة، حتى لا يتشارك مولّد الحمل
 * (الذي يرسل آلاف الطلبات) والخادم حلقة أحداث واحدة على نفس النواة، فتفسد الأرقام.
 * يستخدم الإطار المترجَم (dist/)، تماماً كما يستخدمه متجر حقيقي.
 *
 * حد المحاولات يبقى بإعداده الافتراضي هنا: سيناريو "سيل محاولات الدخول" في run.js يقيس
 * سرعة رفض المحاولات المحظورة نفسها.
 */
const { createCommerceApp, Logger } = require("../dist/index");

const app = createCommerceApp({
  // قاعدة القياس، يمررها run.js في متغير البيئة.
  databaseUrl: process.env.BENCH_DATABASE_URL,
  // أسرار ثابتة للقياس فقط.
  ownerApiKey: "bench-owner-key-that-is-long-enough-000000",
  authTokenSecret: "bench-token-secret-that-is-long-enough-00000",
  // سجل الأخطاء فقط: طباعة سطر لكل طلب من آلاف الطلبات كانت ستبطئ الخادم وتفسد القياس.
  logger: new Logger("error"),
});

// مسار للقياس فقط: يسمح لـ run.js بقراءة استهلاك هذه العملية للذاكرة. مع الخيار --expose-gc
// يشغّل أولاً جمع "القمامة" (Garbage collection) كاملاً، فتُظهر الأرقام الذاكرة المحتفظ بها
// فعلاً (وهنا يظهر أي تسرب في الذاكرة)، لا البيانات المهملة التي لم تُجمع بعد.
app.router.get("/bench/memory", (_req, res) => {
  if (typeof global.gc === "function") global.gc();
  const m = process.memoryUsage();
  res.json({ rss: m.rss, heapUsed: m.heapUsed });
});

// بعد بدء الاستماع، يخبر العملية الأم (run.js) أنه جاهز عبر قناة الاتصال بين العمليات (IPC).
app.listen(Number(process.env.PORT)).then(() => {
  if (process.send) process.send("ready");
});
