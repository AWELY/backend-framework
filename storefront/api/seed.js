const { CATEGORIES_REPOSITORY, PRODUCTS_REPOSITORY, INVENTORY_REPOSITORY, STAFF_REPOSITORY, hashPassword } = require("maa");
const { buildApp } = require("./app");

/**
 * الكتالوج التجريبي لمتجر ماء: 6 أقسام و 16 منتجاً. الأسعار بالدرهم (1 دينار = 1000).
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
 * npm run seed: يملأ الكتالوج. يطلب مستودعات الوحدات من حاوية الـ DI مباشرة، دون المرور
 * بالـ API، ويطابق الموجود بالـ slug فلا يكرره.
 */
/**
 * أشكال (Variants) لبعض المنتجات: لون الجراب، ومقاس الساعة (المقاس الأكبر بسعر خاص).
 * لكل شكل SKU ومخزون خاص به.
 */
const VARIANTS = {
  "silicone-case": [
    { sku: "CASE-SIL-BLK", title: "أسود", stock: 25 },
    { sku: "CASE-SIL-CLR", title: "شفاف", stock: 20 },
    { sku: "CASE-SIL-BLU", title: "أزرق", stock: 0 },
  ],
  "sport-smartwatch": [
    { sku: "WATCH-SPT-42", title: "مقاس 42 ملم", stock: 5 },
    { sku: "WATCH-SPT-46", title: "مقاس 46 ملم", price: 270000, stock: 3 },
  ],
};

/** كوبونات للتجربة. */
const COUPONS = [
  { code: "WELCOME10", kind: "percent", value: 10, minSubtotal: 0 },
  { code: "SAVE20", kind: "fixed", value: 20000, minSubtotal: 200000 },
];

/**
 * حسابات موظفين للتجربة (كلمات مرور التطوير فقط؛ غيّرها في أي متجر حقيقي من لوحة الإدارة بمفتاح المالك).
 * المدير والمشرف والدعم يدخلون لوحة الإدارة (admin.html)، والمندوبان تطبيق التوصيل (courier.html).
 */
const STAFF = [
  { email: "admin@maa.ly", password: "maa-admin-2026", name: "مدير المتجر", role: "admin", phone: "0910000001" },
  { email: "manager@maa.ly", password: "maa-manager-2026", name: "مشرف الطلبات", role: "manager", phone: "0910000002" },
  { email: "support@maa.ly", password: "maa-support-2026", name: "خدمة العملاء", role: "support", phone: "0910000003" },
  { email: "courier1@maa.ly", password: "maa-courier-2026", name: "سالم المندوب", role: "courier", phone: "0920000001" },
  { email: "courier2@maa.ly", password: "maa-courier-2026", name: "علي المندوب", role: "courier", phone: "0920000002" },
];

/**
 * يملأ القاعدة. آمن عند التكرار: ما يوجد لا يُنشأ مرة ثانية، فيطبع "nothing to do" في المرة الثانية.
 */
async function main() {
  // "warn": سجل هادئ أثناء الملء.
  const { app } = buildApp("warn");
  const categories = app.container.resolve(CATEGORIES_REPOSITORY);
  const products = app.container.resolve(PRODUCTS_REPOSITORY);
  const inventory = app.container.resolve(INVENTORY_REPOSITORY);
  const staff = app.container.resolve(STAFF_REPOSITORY);
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
        let product = existingProducts.find((p) => p.slug === item.slug);
        if (product) {
          // القواعد التي مُلئت قبل إضافة الصور الحقيقية ما زالت تشير إلى الرسومات القديمة،
          // فنحدّث مسار الصورة فقط، ولا نلمس السعر ولا المخزون.
          if (product.imageUrl !== imageUrl) {
            await products.update(product.id, { imageUrl });
            created++;
          }
        } else {
          product = await products.create({
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
        const existingVariants = await products.listVariants(product.id, { includeInactive: true });
        for (const [position, v] of (VARIANTS[item.slug] ?? []).entries()) {
          if (existingVariants.some((e) => e.sku === v.sku)) continue;
          const variant = await products.createVariant(product.id, { sku: v.sku, title: v.title, price: v.price ?? null, position });
          await inventory.setVariant(variant.id, v.stock);
          created++;
        }
      }
    }

    for (const c of COUPONS) {
      const result = await app.pool.query(
        `INSERT INTO coupons (code, kind, value, min_subtotal) VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO NOTHING`,
        [c.code, c.kind, c.value, c.minSubtotal]
      );
      created += result.rowCount ?? 0;
    }

    for (const member of STAFF) {
      if (await staff.findCredentials(member.email)) continue;
      await staff.create({ ...member, passwordHash: await hashPassword(member.password) });
      created++;
    }

    console.log(created ? `Seeded ${created} record(s).` : "Catalogue already seeded - nothing to do.");
    console.log("Staff accounts (development only):");
    for (const m of STAFF) console.log(`  ${m.role.padEnd(8)} ${m.email.padEnd(18)} ${m.password}`);
  } finally {
    await app.pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
