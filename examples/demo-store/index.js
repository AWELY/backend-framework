const { buildApp } = require("./app");

// npm start: يبني التطبيق ويبدأ الاستماع. شغّل npm run migrate ثم npm run seed قبل أول تشغيل.
async function main() {
  const { app, config } = buildApp();
  await app.listen(config.port);
  app.logger.info(`demo-store listening on http://localhost:${config.port}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
