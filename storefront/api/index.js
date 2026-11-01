const { buildApp } = require("./app");

/**
 * تشغيل الـ API الخاص بمتجر AMA (يشغّله start.js، أو مباشرة: node api/index.js).
 * يبني التطبيق، ثم يستمع على المنفذ (3000 افتراضياً).
 */
async function main() {
  const { app, config } = buildApp();
  try {
    await app.listen(config.port);
  } catch (err) {
    // فشل الاستماع: نغلق ما فُتح (اتصالات القاعدة)، ونتجاهل أي خطأ في الإغلاق نفسه.
    await app.close().catch(() => {});
    // المنفذ مشغول: رسالة واضحة تقول ماذا تفعل، بدل رسالة Node التقنية.
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

// أي خطأ في الإقلاع: نطبع رسالته فقط، ورمز الخروج 1 يجعل start.js يوقف الموقع أيضاً.
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
