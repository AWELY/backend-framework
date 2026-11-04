const { parseArgs } = require("node:util");
const { hashPassword } = require("commerce-framework");
const { buildApp } = require("./app");
const { STAFF_REPOSITORY, STAFF_ROLES, normalizeEmail } = require("./plugins/staff");

/**
 * ينشئ حساب موظف (مدير أو مندوب) من الطرفية. هكذا يُنشأ أول مدير في متجر حقيقي، قبل أن
 * توجد لوحة تحكم يدخل منها. بعد ذلك يضيف المدير باقي الموظفين من اللوحة نفسها.
 *
 *   npm run create-staff -- --role admin --name "علي" --email ali@ama.ly --password "كلمة-مرور-قوية"
 *   npm run create-staff -- --role courier --name "سالم" --email salem@ama.ly --password "..." --phone 0912345678
 *
 * "--" بعد create-staff تخبر npm أن ما بعدها معاملات لهذا السكربت، لا لـ npm نفسه.
 */
const { values } = parseArgs({
  options: {
    role: { type: "string" },
    name: { type: "string" },
    email: { type: "string" },
    password: { type: "string" },
    phone: { type: "string" },
  },
});

async function main() {
  // نفس شروط مسار POST /staff، برسائل واضحة قبل أن نتصل بالقاعدة.
  if (!STAFF_ROLES.includes(values.role)) throw new Error(`--role must be one of: ${STAFF_ROLES.join(", ")}`);
  if (!values.name?.trim()) throw new Error("--name is required");
  if (!values.email?.includes("@")) throw new Error("--email is required");
  if (!values.password || values.password.length < 8) throw new Error("--password must be at least 8 characters");

  const { app } = buildApp("warn");
  try {
    const staff = await app.container.resolve(STAFF_REPOSITORY).create({
      role: values.role,
      name: values.name.trim(),
      email: normalizeEmail(values.email),
      phone: values.phone?.trim() || null,
      passwordHash: await hashPassword(values.password),
    });
    console.log(`Created ${staff.role} account: ${staff.email}`);
  } finally {
    await app.pool.end();
  }
}

main().catch((err) => {
  // بريد مسجل من قبل: الإطار يترجم خطأ القاعدة إلى هذه الرسالة.
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
