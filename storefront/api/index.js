const { buildApp } = require("./app");

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
  app.logger.info(`AMA API listening on http://localhost:${config.port}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
