const { installShutdownHandlers } = require("maa");
const { buildApp } = require("./app");

/**
 * تشغيل الـ API الخاص بمتجر ماء (يشغّله start.js، أو مباشرة: node api/index.js).
 * يبني التطبيق، ثم يستمع على المنفذ (3000 افتراضياً)، ويوقف نفسه بلطف عند Ctrl+C أو SIGTERM.
 */
async function main() {
  const { app, config } = buildApp();
  try {
    await app.listen(config.port);
  } catch (err) {
    await app.close().catch(() => {});
    if (err.code === "EADDRINUSE") {
      throw new Error(
        `Port ${config.port} is already in use - another server is running on it (for example "npm run dev" of the framework). ` +
          `Stop it with Ctrl+C in its terminal, or set a different PORT in storefront/.env.`,
      );
    }
    throw err;
  }
  installShutdownHandlers(app, { timeoutMs: config.shutdownTimeoutMs });
  app.logger.info(`Maa Store API listening on http://localhost:${config.port}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
