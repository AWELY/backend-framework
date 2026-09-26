const { join } = require("node:path");
require("dotenv").config({ quiet: true, path: join(__dirname, "..", ".env") });
const {
  loadConfig,
  Logger,
  createCommerceApp,
  cashOnDelivery,
  cityRateShipping,
  flatRateShipping,
} = require("commerce-framework");

/**
 * AMA's whole back end: the framework does the work, this file only CONFIGURES
 * it for a small electronics store in Tajoura (Tripoli). Amounts are in dirhams
 * (1 LYD = 1000).
 */

// Delivery price per city. Tajoura (where the shop is) is cheapest; the drop-down
// on the website shows the cities in this order.
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
  const app = createCommerceApp({
    databaseUrl: config.databaseUrl,
    ownerApiKey: config.ownerApiKey,
    authTokenSecret: config.authTokenSecret,
    corsOrigin: config.corsOrigin,
    trustProxy: config.trustProxy,
    logger: new Logger(logLevel ?? config.logLevel),
    plugins: [
      cityRateShipping({ name: "توصيل للمنزل", rates: DELIVERY_RATES, freeOver: 500000 }), // free over 500 LYD
      flatRateShipping({ id: "pickup", name: "استلام من المحل - تاجوراء", rate: 0 }),
      cashOnDelivery({
        name: "الدفع نقداً عند الاستلام",
        instructions: "ادفع نقداً للمندوب عند استلام طلبك، أو في المحل إن اخترت الاستلام من المحل.",
      }),
    ],
  });
  return { app, config };
}

module.exports = { buildApp };
