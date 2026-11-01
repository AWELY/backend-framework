// يقرأ ملف .env ويضع قيمه في process.env، قبل أي سطر آخر.
import "dotenv/config";
import { loadConfig, Logger, createCommerceApp } from "./index";

/**
 * خادم التطوير الخاص بهذا المستودع (npm start في مجلد الإطار، ويشغّل dist/dev-server.js).
 *
 * يشغّل الإطار بنفس الطريقة التي يشغّله بها مشروع متجر أنشأته أداة CLI
 * (cli/templates/index.js.template)، لكن من الكود المصدري مباشرة، ودون إضافات.
 * فائدته: تجربة الـ API أثناء تطوير الإطار نفسه.
 *
 * شغّل npm run migrate مرة واحدة قبل أول تشغيل، لإنشاء الجداول.
 */
async function main(): Promise<void> {
  // الإعدادات بعد التحقق منها (يفشل هنا إن نقص متغير، أو كان سر ضعيفاً).
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

// أي خطأ في الإقلاع يُطبع، ورمز الخروج 1 يعني "فشل" لمن شغّل البرنامج.
main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
