"use strict";

/**
 * npm start: يشغّل الـ API والموقع معاً في نافذة طرفية واحدة.
 *   - Ctrl+C يوقف الاثنين.
 *   - إن توقف أحدهما (مثلاً فشل الـ API لأن المنفذ مشغول)، يُوقَف الآخر أيضاً.
 *
 * لماذا عمليتان منفصلتان وليس برنامجاً واحداً؟ لأن المعمارية Headless: الموقع والـ API
 * برنامجان مستقلان. في الإنتاج قد يكون الموقع على خدمة استضافة ملفات، والـ API على
 * خادم آخر. هذا الملف مجرد راحة أثناء التطوير.
 */

const { spawn } = require("node:child_process");
const { join } = require("node:path");

// الخدمتان: الـ API على 3000، والموقع على 5173.
const services = [
  { name: "api", file: join(__dirname, "api", "index.js") },
  { name: "web", file: join(__dirname, "web-server.js") },
];

const children = services.map(({ name, file }) => {
  // spawn ينشئ عملية Node جديدة لكل ملف. process.execPath هو مسار برنامج node نفسه.
  // stdio: لا مدخلات ("ignore")، ومخرجاتها وأخطاؤها تصل إلينا ("pipe") لنضيف لها بادئة.
  const child = spawn(process.execPath, [file], { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"] });
  // يضيف [api] أو [web] أول كل سطر، لتعرف من كتب ماذا.
  const prefix = (chunk) =>
    chunk
      .toString()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => `[${name}] ${line}`)
      .join("\n") + "\n";
  child.stdout.on("data", (d) => process.stdout.write(prefix(d)));
  child.stderr.on("data", (d) => process.stderr.write(prefix(d)));
  // توقفت هذه العملية: نوقف الأخرى إن كانت ما زالت تعمل (exitCode === null).
  child.on("exit", (code) => {
    console.log(`[${name}] stopped (exit code ${code})`);
    for (const other of children) if (other !== child && other.exitCode === null) other.kill();
    process.exitCode = code ?? 0;
  });
  return child;
});

// Ctrl+C يرسل SIGINT، وأمر الإيقاف من النظام يرسل SIGTERM: نوقف العمليتين في الحالتين.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const child of children) if (child.exitCode === null) child.kill();
  });
}
