require("dotenv").config({ quiet: true });
const {
  loadConfig,
  Logger,
  createCommerceApp,
  cashOnDelivery,
  flatRateShipping,
} = require("commerce-framework");

/**
 * إعداد المتجر التجريبي كاملاً، وهو الكود الوحيد الخاص بالإطار في هذا المشروع.
 * كل شيء آخر (المسارات، والمصادقة، والتحقق، وقاعدة البيانات) يأتي من الإطار،
 * وهذا بالضبط ما يريد المتجر التجريبي إثباته: متجر كامل بأسطر قليلة.
 *
 * buildApp مفصولة في ملف خاص، لأن ثلاثة ملفات تحتاجها: index.js (التشغيل)،
 * و migrate.js (الجداول)، و seed.js (البيانات الأولية).
 *
 * الإضافات: الدفع عند الاستلام، وطريقتا شحن (عادي بـ 10 دنانير ومجاني فوق 200،
 * وسريع بـ 25 ديناراً). المبالغ بالدرهم.
 */
function buildApp(logLevel) {
  const config = loadConfig();
  const app = createCommerceApp({
    databaseUrl: config.databaseUrl,
    ownerApiKey: config.ownerApiKey,
    authTokenSecret: config.authTokenSecret,
    corsOrigin: config.corsOrigin,
    trustProxy: config.trustProxy,
    // مستوى السجل: من المعامل إن مُرّر (مثلاً "warn" في seed.js ليكون الناتج هادئاً)، وإلا من .env.
    logger: new Logger(logLevel ?? config.logLevel),
    plugins: [
      cashOnDelivery(),
      flatRateShipping({ name: "Standard delivery (2-4 days)", rate: 10000, freeOver: 200000 }),
      // نفس الإضافة مرة ثانية بمعرّف مختلف: خيار شحن ثانٍ.
      flatRateShipping({ id: "express", name: "Express delivery (next day)", rate: 25000 }),
    ],
  });
  return { app, config };
}

module.exports = { buildApp };
