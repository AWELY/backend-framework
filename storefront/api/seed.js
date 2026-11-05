const { CATEGORIES_REPOSITORY, PRODUCTS_REPOSITORY, INVENTORY_REPOSITORY, hashPassword } = require("commerce-framework");
const { buildApp } = require("./app");
const { STAFF_REPOSITORY } = require("./plugins/staff");

/**
 * الكتالوج التجريبي لمتجر AMA: 6 أقسام و 16 منتجاً، و3 حسابات موظفين تجريبية (مدير ومندوبان).
 * الأسعار بالدرهم (1 دينار = 1000).
 *
 * كميات المخزون متنوعة عمداً (نفد، وبقي 2 فقط، وكمية كبيرة)، ليعرض الموقع كل حالات المخزون.
 * صورة كل منتج في web/images/products/<slug>.webp (صور مجانية من Unsplash، ومصادرها في
 * web/images/products/CREDITS.md).
 *
 * تشغيله مرتين آمن: المنتجات الموجودة تبقى، ويُحدَّث مسار صورتها فقط إن تغيّر.
 */
const CATALOGUE = [
  {
    category: { name: "شواحن وكوابل", slug: "chargers-cables", description: "شواحن سريعة وكوابل أصلية لكل الأجهزة" },
    products: [
      { slug: "fast-charger-20w", name: "شاحن سريع 20 واط USB-C", price: 35000, stock: 40,
        description: "شاحن جداري سريع بقوة 20 واط بمنفذ USB-C، يشحن الهاتف حتى 50% خلال 30 دقيقة تقريباً. متوافق مع آيفون وأندرويد." },
      { slug: "charger-65w-gan", name: "شاحن GaN بقوة 65 واط بثلاث منافذ", price: 95000, stock: 12,
        description: "شاحن صغير الحجم بتقنية GaN، بمنفذين USB-C ومنفذ USB-A. يشحن اللابتوب والهاتف معاً." },
      { slug: "cable-usbc-1m", name: "كابل USB-C إلى USB-C طول متر", price: 15000, stock: 80,
        description: "كابل مقوّى بالنايلون يدعم الشحن السريع حتى 60 واط ونقل البيانات." },
      { slug: "cable-lightning", name: "كابل لايتنينغ للآيفون", price: 18000, stock: 2,
        description: "كابل USB-C إلى Lightning يدعم الشحن السريع لأجهزة آيفون." },
      { slug: "car-charger-dual", name: "شاحن سيارة مزدوج", price: 28000, stock: 20,
        description: "شاحن سيارة بمنفذين يشحن جهازين في نفس الوقت، مع حماية من ارتفاع الحرارة." },
    ],
  },
  {
    category: { name: "سماعات", slug: "audio", description: "سماعات لاسلكية وسلكية" },
    products: [
      { slug: "wireless-earbuds", name: "سماعات لاسلكية بلوتوث مع علبة شحن", price: 120000, stock: 15,
        description: "سماعات أذن لاسلكية بصوت نقي، تعمل حتى 6 ساعات، وعلبة الشحن تكفي 24 ساعة إضافية." },
      { slug: "anc-headphones", name: "سماعة رأس بعزل الضوضاء", price: 280000, stock: 5,
        description: "سماعة رأس لاسلكية بخاصية عزل الضوضاء النشط، وبطارية تدوم حتى 30 ساعة." },
      { slug: "wired-earphones", name: "سماعات سلكية 3.5 ملم", price: 20000, stock: 0,
        description: "سماعات سلكية خفيفة مع ميكروفون وأزرار للتحكم بالصوت." },
    ],
  },
  {
    category: { name: "ساعات ذكية", slug: "smartwatches", description: "ساعات وأساور ذكية" },
    products: [
      { slug: "sport-smartwatch", name: "ساعة ذكية رياضية", price: 250000, stock: 8,
        description: "ساعة ذكية بشاشة ملونة، تقيس نبض القلب والخطوات والنوم، ومقاومة للماء." },
      { slug: "fitness-band", name: "سوار لياقة ذكي", price: 95000, stock: 2,
        description: "سوار خفيف لمتابعة النشاط اليومي والإشعارات، وبطارية تدوم أسبوعين." },
    ],
  },
  {
    category: { name: "باور بانك", slug: "power-banks", description: "بطاريات متنقلة لكل يوم" },
    products: [
      { slug: "power-bank-10000", name: "باور بانك 10000 مللي أمبير", price: 65000, stock: 25,
        description: "بطارية متنقلة صغيرة تشحن الهاتف مرتين تقريباً، بمنفذ USB-C." },
      { slug: "power-bank-20000", name: "باور بانك 20000 مللي أمبير شحن سريع", price: 110000, stock: 10,
        description: "بطارية كبيرة بقوة 22.5 واط تشحن الهاتف حتى 4 مرات، مع شاشة تعرض نسبة الشحن." },
    ],
  },
  {
    category: { name: "جرابات وحماية", slug: "cases-protection", description: "جرابات وواقيات شاشة" },
    products: [
      { slug: "silicone-case", name: "جراب سيليكون مقاوم للصدمات", price: 25000, stock: 60,
        description: "جراب سيليكون ناعم يحمي الهاتف من الصدمات والخدوش، متوفر لأغلب الموديلات." },
      { slug: "glass-screen-protector", name: "واقي شاشة زجاج 9H", price: 15000, stock: 100,
        description: "واقي شاشة زجاجي بصلابة 9H، شفاف تماماً ولا يؤثر على اللمس." },
    ],
  },
  {
    category: { name: "مكبرات صوت", slug: "speakers", description: "مكبرات صوت بلوتوث" },
    products: [
      { slug: "bluetooth-speaker", name: "مكبر صوت بلوتوث محمول", price: 150000, stock: 7,
        description: "مكبر صوت صغير بصوت قوي وبطارية تدوم 12 ساعة." },
      { slug: "waterproof-speaker", name: "مكبر صوت مقاوم للماء", price: 210000, stock: 4,
        description: "مكبر صوت مقاوم للماء والغبار، مناسب للرحلات والبحر." },
    ],
  },
];

/**
 * حسابات موظفين تجريبية، لتجربة لوحة التحكم وتطبيق المندوب مباشرة بعد التثبيت.
 * كلمات المرور معروفة (مكتوبة في README)، فهي لقاعدة تجريبية فقط. لهذا لا تُنشأ أبداً إن كان
 * NODE_ENV=production: على متجر حقيقي يُملأ الكتالوج فقط، وتُنشأ الحسابات بـ npm run create-staff.
 */
const DEMO_STAFF = [
  { role: "admin", name: "مدير المتجر", email: "admin@ama.ly", phone: "0910000001", password: "Ama@admin2026" },
  { role: "courier", name: "أحمد سالم", email: "ahmed@ama.ly", phone: "0920000002", password: "Ama@courier2026" },
  { role: "courier", name: "خالد عمر", email: "khaled@ama.ly", phone: "0910000003", password: "Ama@courier2026" },
];

/**
 * npm run seed: يملأ الكتالوج. يطلب مستودعات الوحدات من حاوية الـ DI مباشرة، دون المرور
 * بالـ API، ويطابق الموجود بالـ slug فلا يكرره.
 */
async function main() {
  // "warn": سجل هادئ أثناء الملء.
  const { app } = buildApp("warn");
  const categories = app.container.resolve(CATEGORIES_REPOSITORY);
  const products = app.container.resolve(PRODUCTS_REPOSITORY);
  const inventory = app.container.resolve(INVENTORY_REPOSITORY);
  let created = 0;
  try {
    const existingCategories = await categories.findAll({ limit: 100 });
    const existingProducts = await products.list({ includeInactive: true, limit: 100, offset: 0 });
    for (const group of CATALOGUE) {
      let category = existingCategories.find((c) => c.slug === group.category.slug);
      if (!category) {
        category = await categories.create(group.category);
        created++;
      }
      for (const item of group.products) {
        // مسار الصورة على موقع المتجر نفسه، يقدمه web-server.js من مجلد web.
        const imageUrl = `/images/products/${item.slug}.webp`;
        const existing = existingProducts.find((p) => p.slug === item.slug);
        if (existing) {
          // القواعد التي مُلئت قبل إضافة الصور الحقيقية ما زالت تشير إلى الرسومات القديمة،
          // فنحدّث مسار الصورة فقط، ولا نلمس السعر ولا المخزون.
          if (existing.imageUrl !== imageUrl) {
            await products.update(existing.id, { imageUrl });
            created++;
          }
          continue;
        }
        const product = await products.create({
          name: item.name,
          slug: item.slug,
          description: item.description,
          price: item.price,
          categoryId: category.id,
          imageUrl,
        });
        await inventory.set(product.id, item.stock);
        created++;
      }
    }
    // الموظفون التجريبيون: من مستودع إضافة الموظفين في الحاوية، تماماً كمستودعات الإطار.
    // الموجود (بنفس البريد) لا يُلمس، فتشغيل seed مرة ثانية لا يعيد كلمة مرور غيّرتها.
    const staff = app.container.resolve(STAFF_REPOSITORY);
    const demoStaff = process.env.NODE_ENV === "production" ? [] : DEMO_STAFF;
    if (!demoStaff.length) console.log("NODE_ENV=production: demo staff accounts skipped - use npm run create-staff.");
    for (const member of demoStaff) {
      if (await staff.findCredentials(member.email)) continue;
      const { password, ...rest } = member;
      await staff.create({ ...rest, passwordHash: await hashPassword(password) });
      created++;
    }
    console.log(created ? `Seeded ${created} record(s).` : "Catalogue already seeded - nothing to do.");
  } finally {
    await app.pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
