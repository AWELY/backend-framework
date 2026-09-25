require("dotenv").config({ quiet: true });
const {
  loadConfig,
  Logger,
  createCommerceApp,
  cashOnDelivery,
  flatRateShipping,
} = require("commerce-framework");

/**
 * The demo store's whole configuration - the only framework-specific code in
 * this project. Everything else (routes, auth, validation, database) comes from
 * the framework, which is the point of the demo.
 */
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
      cashOnDelivery(),
      flatRateShipping({ name: "Standard delivery (2-4 days)", rate: 10000, freeOver: 200000 }),
      flatRateShipping({ id: "express", name: "Express delivery (next day)", rate: 25000 }),
    ],
  });
  return { app, config };
}

module.exports = { buildApp };
