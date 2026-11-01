const { join } = require("node:path");
require("dotenv").config({ quiet: true, path: join(__dirname, "..", ".env") });
const { createHash } = require("node:crypto");
const {
  loadConfig,
  Logger,
  createCommerceApp,
  optionsFromConfig,
  cashOnDelivery,
  cityRateShipping,
  flatRateShipping,
  coupons,
} = require("maa");
const { demoCardGateway } = require("./plugins/demo-card-gateway");
const { devMailbox } = require("./plugins/dev-mailbox");

/**
 * الـ API الخاص بمتجر ماء (Maa Store): تطبيق واحد من الإطار مع إضافات المتجر.
 *
 *   - التوصيل حسب المدينة (cityRateShipping) والاستلام من المحل (flatRateShipping بسعر 0).
 *   - الدفع عند الاستلام (cashOnDelivery)، وبطاقة تجريبية في وضع التجربة فقط (demo-card-gateway: webhook موقّع، ومهلة دفع، واسترجاع).
 *   - الكوبونات (coupons) من الإطار.
 *   - صندوق بريد للتطوير (dev-mailbox): روابط استعادة كلمة المرور وإشعارات الطلبات.
 *   - حد للطلبات وإنشاء السلال لكل IP (المتجر يعمل دون proxy في التطوير؛ خلف nginx فعّل TRUST_PROXY).
 *
 * optionsFromConfig تقرأ كل إعدادات الإطار من .env (المفحوصة عند الإقلاع)، وهنا نضيف ما يخص المتجر فقط.
 */

/** أسعار التوصيل بالدرهم (1 دينار = 1000 درهم). تاجوراء الأرخص لأن المحل فيها. */
const DELIVERY_RATES = {
  "تاجوراء": 5000,
  "طرابلس": 10000,
  "جنزور": 12000,
  "القره بوللي": 15000,
  "الزاوية": 15000,
  "صبراتة": 20000,
  "غريان": 20000,
  "الخمس": 20000,
  "زليتن": 20000,
  "مصراتة": 25000,
  "سرت": 35000,
  "بنغازي": 40000,
  "البيضاء": 45000,
  "درنة": 45000,
  "طبرق": 50000,
  "سبها": 50000,
};

function buildApp(logLevel) {
  const config = loadConfig();
  const webOrigin = process.env.WEB_ORIGIN ?? `http://localhost:${process.env.WEB_PORT ?? 5173}`;
  // سر الـ webhook التجريبي: من .env إن وُجد، وإلا مشتق من سر التوكنات (ثابت بين إعادات التشغيل).
  const webhookSecret =
    process.env.DEMO_GATEWAY_SECRET || createHash("sha256").update(`demo-gateway:${config.authTokenSecret}`).digest("hex");
  const demoMode = (process.env.DEMO_MODE ?? (config.env === "production" ? "false" : "true")) === "true";

  const app = createCommerceApp({
    ...optionsFromConfig(config, new Logger(logLevel ?? config.logLevel, { format: config.logFormat })),
    checkoutRateLimit: { maxFailures: 30, windowSeconds: 10 * 60 },
    cartCreationRateLimit: { maxFailures: 200, windowSeconds: 60 * 60 },
    plugins: [
      cityRateShipping({ name: "توصيل للمنزل", rates: DELIVERY_RATES, freeOver: 500000 }), // مجاني فوق 500 دينار
      flatRateShipping({ id: "pickup", name: "استلام من المحل - تاجوراء", rate: 0 }),
      cashOnDelivery({
        name: "الدفع نقداً عند الاستلام",
        instructions: "ادفع نقداً للمندوب عند استلام طلبك، أو في المحل إن اخترت الاستلام من المحل.",
      }),
      // البوابة التجريبية وصندوق البريد للتطوير فقط: في الإنتاج (DEMO_MODE=false) لا يوجد مسار
      // /payments/card/simulate يسمح بتعليم طلب "مدفوعاً" بمعرفة رقمه وهاتفه.
      ...(demoMode ? [demoCardGateway({ payPageUrl: `${webOrigin}/pay.html`, webhookSecret })] : []),
      coupons(),
      devMailbox({ webOrigin, enabled: demoMode }),
    ],
  });
  return { app, config };
}

module.exports = { buildApp };
