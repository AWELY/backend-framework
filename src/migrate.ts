// يقرأ ملف .env ويضع قيمه في process.env.
import "dotenv/config";
import { createPool } from "./db/connection";
import { runMigrations } from "./db/migrations";
import { coreModules, collectMigrations } from "./modules";
import { runtimeMigrations } from "./runtime/migrations";

/**
 * الأمر npm run migrate في مجلد الإطار: ينشئ جداول كل الوحدات المدمجة أو يحدّثها،
 * في القاعدة المحددة في DATABASE_URL.
 *
 * لا يحتاج مفتاح المالك ولا سر التوكن، لأنه لا يشغّل خادماً: يتصل بالقاعدة، ويطبّق
 * ما لم يُطبَّق بعد، ثم يغلق الاتصال وينتهي.
 * تشغيله مرة ثانية آمن: يرد "Database is already up to date".
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
  const pool = createPool(url);
  try {
    const applied = await runMigrations(pool, [...runtimeMigrations, ...collectMigrations(coreModules)], (m) => console.log(m));
    console.log(applied.length ? `Done: ${applied.length} migration(s) applied.` : "Database is already up to date.");
  } finally {
    // يعمل دائماً، نجح أو فشل: نغلق الاتصالات، وإلا بقي البرنامج يعمل ولم ينتهِ.
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
