const { parseArgs } = require("node:util");
const { hashPassword, validate } = require("commerce-framework");
const { buildApp } = require("./app");
const { STAFF_REPOSITORY, normalizeEmail, createSchema } = require("./plugins/staff");

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
  // نفس قواعد مسار POST /staff تماماً (createSchema من إضافة الموظفين، ومدقّق الإطار نفسه)،
  // قبل أن نتصل بالقاعدة. الحقول الناقصة لا تُمرَّر، فيقول المدقّق إنها مطلوبة.
  const input = Object.fromEntries(
    Object.entries({ role: values.role, name: values.name?.trim(), email: values.email?.trim(), password: values.password, phone: values.phone?.trim() })
      .filter(([, v]) => v)
  );
  let valid;
  try {
    valid = validate(createSchema, input);
  } catch (err) {
    // ValidationError من الإطار: details قائمة الحقول الخاطئة، فنطبعها سطراً لكل حقل.
    const lines = (err.details ?? []).map((d) => `  --${d.field}: ${d.message}`).join("\n");
    throw new Error(`Invalid staff account:\n${lines}`);
  }

  const { app } = buildApp("warn");
  try {
    const staff = await app.container.resolve(STAFF_REPOSITORY).create({
      role: valid.role,
      name: valid.name,
      email: normalizeEmail(valid.email),
      phone: valid.phone ?? null,
      passwordHash: await hashPassword(valid.password),
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
