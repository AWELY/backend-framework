#!/usr/bin/env node
"use strict";

/**
 * أداة إنشاء المشاريع (CLI). الأمر:
 *   node cli/index.js create my-store
 * ينشئ مشروع متجر جديداً وبسيطاً في مجلد بجانب مجلد الإطار (مثل ../my-store)، مربوطاً
 * بالإطار عبر اعتمادية "file:".
 *
 * السطر الأول (#!/usr/bin/env node) اسمه Shebang: يجعل الملف قابلاً للتشغيل مباشرة كأمر
 * في Linux و macOS. و "use strict" تفعّل الوضع الصارم في JavaScript.
 *
 * قراءة معاملات سطر الأوامر بمكتبة commander (مذكورة في جدول تقنيات المقترح). اخترناها
 * بدل yargs لأنها بلا أي اعتماديات فرعية.
 *
 * الأداة لا تستورد كود الإطار نفسه (src/ أو dist/)، فلا تحتاج خطوة ترجمة لتعمل.
 * لهذا هي ملف JavaScript عادي، وليست TypeScript.
 */

const { Command } = require("commander");
const { mkdirSync, readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join, resolve, relative, basename } = require("node:path");
const { execFileSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");

// مجلد الإطار: المجلد الأعلى من مجلد cli. و __dirname هو مجلد هذا الملف.
const frameworkRoot = resolve(__dirname, "..");
// رقم إصدار الإطار من package.json، يظهر مع الأمر --version.
const { version } = require(join(frameworkRoot, "package.json"));

/**
 * يستبدل كل علامة __KEY__ في القالب بقيمتها.
 * مثال: "__PROJECT_NAME__ listening" مع { PROJECT_NAME: "my-store" } يصبح "my-store listening".
 * split ثم join طريقة بسيطة لاستبدال كل المواضع دون تعبير نمطي.
 */
function renderTemplate(content, replacements) {
  let out = content;
  for (const [key, value] of Object.entries(replacements)) {
    out = out.split(`__${key}__`).join(value);
  }
  return out;
}

/** ينشئ المشروع الجديد خطوة بخطوة. أي خطأ يُرمى ويُطبع برسالة واضحة (انظر action في الأسفل). */
function createProject(projectName) {
  // 1. الاسم يصبح اسم حزمة npm واسم مجلد: حروف إنجليزية صغيرة وأرقام وشرطات فقط.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(projectName)) {
    throw new Error(
      `Invalid project name "${projectName}": use lowercase letters, digits and dashes (it becomes the npm package name).`
    );
  }

  // 2. المشروع الجديد يستخدم الإطار المترجَم (dist/)، فإن لم يكن مترجَماً نترجمه أولاً.
  const distEntry = join(frameworkRoot, "dist", "index.js");
  if (!existsSync(distEntry)) {
    console.log("Framework is not built yet - running `npm run build` first...");
    // shell: true لازمة في Windows لتشغيل npm (وهو ملف npm.cmd هناك).
    execFileSync("npm", ["run", "build"], { cwd: frameworkRoot, stdio: "inherit", shell: true });
  }

  // 3. المجلد يُنشأ بجانب مجلد الإطار (مثل ../my-store)، فيبقى مسار اعتمادية "file:"
  //    قصيراً ومتوقعاً، من أي مكان شُغّل منه الأمر.
  const targetDir = resolve(frameworkRoot, "..", projectName);
  if (existsSync(targetDir)) {
    throw new Error(`Directory already exists: ${targetDir}`);
  }
  mkdirSync(targetDir, { recursive: true });

  // 4. مسار الإطار نسبةً إلى المشروع الجديد (مثل "../backend framework")، بشرطات "/"
  //    حتى في Windows، لأن npm يقبلها في كل الأنظمة.
  const templatesDir = join(__dirname, "templates");
  const frameworkPath = relative(targetDir, frameworkRoot).split("\\").join("/");
  const replacements = { PROJECT_NAME: projectName, FRAMEWORK_PATH: frameworkPath };

  // 5. كل قالب واسم الملف الذي يصبحه في المشروع الجديد.
  const files = [
    ["package.json.template", "package.json"],
    ["env.template", ".env.example"],
    ["index.js.template", "index.js"],
    ["migrate.js.template", "migrate.js"],
    ["gitignore.template", ".gitignore"],
  ];
  for (const [template, outName] of files) {
    const content = renderTemplate(readFileSync(join(templatesDir, template), "utf8"), replacements);
    writeFileSync(join(targetDir, outName), content);
  }

  // 6. ملف .env جاهز بأسرار عشوائية جديدة، فلا يبقى على المستخدم إلا رابط القاعدة.
  //    randomBytes(32) تعطي 32 بايتاً عشوائية آمنة، تصبح 64 حرفاً سداسياً.
  //    التعبير /^OWNER_API_KEY=.*$/m يطابق السطر كاملاً (m تجعل ^ و $ لكل سطر).
  //    و .env مستثنى في .gitignore الذي أنشأناه، فلا يُرفع إلى GitHub.
  const env = renderTemplate(readFileSync(join(templatesDir, "env.template"), "utf8"), replacements)
    .replace(/^OWNER_API_KEY=.*$/m, `OWNER_API_KEY=${randomBytes(32).toString("hex")}`)
    .replace(/^AUTH_TOKEN_SECRET=.*$/m, `AUTH_TOKEN_SECRET=${randomBytes(32).toString("hex")}`);
  writeFileSync(join(targetDir, ".env"), env);

  // 7. الخطوات التالية للمستخدم.
  console.log(`Created ${basename(targetDir)}/ at ${targetDir}`);
  console.log("A .env with random OWNER_API_KEY and AUTH_TOKEN_SECRET was generated.");
  console.log("Next steps:");
  console.log(`  cd ${relative(process.cwd(), targetDir) || "."}`);
  console.log("  npm install");
  console.log("  # set DATABASE_URL in .env to an existing PostgreSQL database");
  console.log("  npm run migrate");
  console.log("  npm start");
}

// تعريف الأوامر بمكتبة commander.
const program = new Command();

program
  .name("commerce-cli")
  .description("Scaffolding tool for the commerce framework")
  .version(version);

// الأمر create، ومعامل إلزامي واحد هو اسم المشروع (<...> تعني إلزامي).
program
  .command("create")
  .description("create a new store project next to the framework folder")
  .argument("<project-name>", "folder and npm package name for the new project")
  .action((projectName) => {
    try {
      createProject(projectName);
    } catch (err) {
      // رسالة واضحة بدل الـ stack كاملاً، ورمز خروج 1 يعني "فشل".
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    }
  });

// يقرأ معاملات سطر الأوامر (process.argv) وينفّذ الأمر المطلوب.
program.parse();
