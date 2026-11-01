// يقرأ ملف .env ويضع قيمه في process.env، قبل أي سطر آخر.
import "dotenv/config";
import { loadConfig, createCommerceApp, optionsFromConfig, installShutdownHandlers } from "./index";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = createCommerceApp(optionsFromConfig(config));
  await app.listen(config.port);
  // Ctrl+C أو SIGTERM: إيقاف لطيف (الطلبات الجارية تكتمل، ثم يُغلق العامل والقاعدة).
  installShutdownHandlers(app, { timeoutMs: config.shutdownTimeoutMs });
  app.logger.info(`Dev server listening on port ${config.port} (${config.env})`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
