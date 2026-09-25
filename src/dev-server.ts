import "dotenv/config";
import { loadConfig, Logger, createCommerceApp } from "./index";

/**
 * This repo's OWN development server - exercises the framework exactly the way
 * a generated store project does (cli/templates/index.js.template), but from
 * source. Run `npm run migrate` once before the first start.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);
  const app = createCommerceApp({
    databaseUrl: config.databaseUrl,
    ownerApiKey: config.ownerApiKey,
    authTokenSecret: config.authTokenSecret,
    corsOrigin: config.corsOrigin,
    trustProxy: config.trustProxy,
    logger,
  });
  await app.listen(config.port);
  logger.info(`Dev server listening on port ${config.port} (${config.env})`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
