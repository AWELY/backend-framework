"use strict";

/**
 * فحص قواعد الكود التي لا يفحصها TypeScript (npm run lint). دون اعتمادية: قراءة ملفات وتعبيرات نمطية.
 *
 * القواعد:
 *   1. حدود الطبقات (المعمارية في docs/ARCHITECTURE.md):
 *        engine/     لا يستورد من أي مجلد آخر في src
 *        container/  لا يستورد من أي مجلد آخر في src
 *        middleware/ يستورد من engine فقط
 *        db/         يستورد من engine فقط
 *        runtime/    يستورد من engine و db و middleware (الواجهات) فقط، لا من الوحدات
 *        plugins/    لا يستورد ملفات داخلية لوحدة (مثل modules/orders/orders.service)
 *   2. لا تحويل يدوي لمدخلات الطلب في الوحدات والإضافات: "req.body as" و "req.params.x as"
 *      (withInput يعطي النوع الصحيح).
 *   3. لا any في src.
 *   4. لا console في src (السجل يمر بـ Logger)، ما عدا سكربتات التشغيل.
 *   5. لا .only في الاختبارات (اختبار واحد يعمل والباقي يُتجاهل بصمت).
 *   6. أمثلة الإضافات الخارجية (examples/plugins) تستورد من الواجهة العامة فقط ("./maa").
 */

const { readFileSync, readdirSync, statSync } = require("node:fs");
const { join, relative, sep } = require("node:path");

const ROOT = join(__dirname, "..");
const problems = [];

function files(dir, ext) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path, ext));
    else if (path.endsWith(ext)) out.push(path);
  }
  return out;
}

function report(file, lineNo, message) {
  problems.push(`${relative(ROOT, file)}:${lineNo}  ${message}`);
}

/** الطبقات المسموح لكل مجلد في src أن يستورد منها (غير نفسه). */
const LAYERS = {
  engine: [],
  container: [],
  middleware: ["engine"],
  db: ["engine"],
  runtime: ["engine", "db", "middleware"],
};

for (const file of files(join(ROOT, "src"), ".ts")) {
  const rel = relative(join(ROOT, "src"), file).split(sep);
  const layer = rel.length > 1 ? rel[0] : null;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const n = i + 1;
    const imported = /from\s+"(\.{1,2}\/[^"]+)"/.exec(line)?.[1];
    if (imported && layer) {
      const target = relative(join(ROOT, "src"), join(file, "..", imported)).split(sep);
      const targetLayer = target.length > 1 ? target[0] : target[0].replace(/\.ts$/, "");
      if (layer in LAYERS && targetLayer !== layer && !LAYERS[layer].includes(targetLayer)) {
        report(file, n, `layer '${layer}' must not import from '${targetLayer}' (${imported})`);
      }
      if (layer === "plugins" && targetLayer === "modules" && target.length > 2) {
        report(file, n, `plugins must use public module APIs (types, shared, extensions), not internals (${imported})`);
      }
    }
    if ((layer === "modules" || layer === "plugins") && /req\.body as |req\.params\.\w+ as /.test(line)) {
      report(file, n, "cast of request input: use withInput() so the type comes from the schema");
    }
    if (/(:\s*any\b|\bas any\b|<any>)/.test(line) && !line.trim().startsWith("*") && !line.trim().startsWith("//")) {
      report(file, n, "'any' is not allowed in src (use unknown and narrow it)");
    }
    const scriptFile = ["dev-server.ts", "migrate.ts"].includes(rel[rel.length - 1]) || rel.join("/") === "engine/logger.ts";
    if (/(^|[^"'`\w.])console\.(log|error|warn|info|debug)\(/.test(line) && !scriptFile) {
      report(file, n, "use the Logger instead of console");
    }
  });
}

for (const file of files(join(ROOT, "tests"), ".ts")) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (/\b(test|describe|it)\.only\(|\{\s*only:\s*true/.test(line)) report(file, i + 1, ".only would silently skip every other test");
    });
}

for (const file of files(join(ROOT, "examples", "plugins"), ".ts")) {
  if (file.endsWith(`${sep}maa.ts`)) continue;
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      const imported = /from\s+"([^"]+)"/.exec(line)?.[1];
      if (imported && imported !== "./maa" && !imported.startsWith("node:")) {
        report(file, i + 1, `third-party examples import only the public API ("./maa"), not ${imported}`);
      }
    });
}

if (problems.length > 0) {
  console.error(`${problems.length} lint problem(s):\n  ${problems.join("\n  ")}`);
  process.exitCode = 1;
} else {
  console.log("lint: no problems");
}
