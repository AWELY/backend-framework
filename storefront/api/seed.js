const { CATEGORIES_REPOSITORY, PRODUCTS_REPOSITORY, INVENTORY_REPOSITORY } = require("commerce-framework");
const { buildApp } = require("./app");

/**
 * AMA's sample catalogue. Prices in dirhams (1 LYD = 1000). Stock levels are
 * deliberately varied (sold out, only 2 left, plenty) so the website shows every
 * stock state. Images are paths on the website (web/images/products/...).
 * Safe to run twice: existing slugs are skipped.
 */
const CATALOGUE = [
  {
    category: { name: "شواحن وكوابل", slug: "chargers-cables", description: "شواحن سريعة وكوابل أصلية لكل الأجهزة" },
    products: [
      { slug: "fast-charger-20w", name: "شاحن سريع 20 واط USB-C", price: 35000, stock: 40, image: "charger",
        description: "شاحن جداري سريع بقوة 20 واط بمنفذ USB-C، يشحن الهاتف حتى 50% خلال 30 دقيقة تقريباً. متوافق مع آيفون وأندرويد." },
      { slug: "charger-65w-gan", name: "شاحن GaN بقوة 65 واط بثلاث منافذ", price: 95000, stock: 12, image: "charger",
        description: "شاحن صغير الحجم بتقنية GaN، بمنفذين USB-C ومنفذ USB-A. يشحن اللابتوب والهاتف معاً." },
      { slug: "cable-usbc-1m", name: "كابل USB-C إلى USB-C طول متر", price: 15000, stock: 80, image: "cable",
        description: "كابل مقوّى بالنايلون يدعم الشحن السريع حتى 60 واط ونقل البيانات." },
      { slug: "cable-lightning", name: "كابل لايتنينغ للآيفون", price: 18000, stock: 2, image: "cable",
        description: "كابل USB-C إلى Lightning يدعم الشحن السريع لأجهزة آيفون." },
      { slug: "car-charger-dual", name: "شاحن سيارة مزدوج", price: 28000, stock: 20, image: "car-charger",
        description: "شاحن سيارة بمنفذين يشحن جهازين في نفس الوقت، مع حماية من ارتفاع الحرارة." },
    ],
  },
  {
    category: { name: "سماعات", slug: "audio", description: "سماعات لاسلكية وسلكية" },
    products: [
      { slug: "wireless-earbuds", name: "سماعات لاسلكية بلوتوث مع علبة شحن", price: 120000, stock: 15, image: "earbuds",
        description: "سماعات أذن لاسلكية بصوت نقي، تعمل حتى 6 ساعات، وعلبة الشحن تكفي 24 ساعة إضافية." },
      { slug: "anc-headphones", name: "سماعة رأس بعزل الضوضاء", price: 280000, stock: 5, image: "headphones",
        description: "سماعة رأس لاسلكية بخاصية عزل الضوضاء النشط، وبطارية تدوم حتى 30 ساعة." },
      { slug: "wired-earphones", name: "سماعات سلكية 3.5 ملم", price: 20000, stock: 0, image: "earbuds",
        description: "سماعات سلكية خفيفة مع ميكروفون وأزرار للتحكم بالصوت." },
    ],
  },
  {
    category: { name: "ساعات ذكية", slug: "smartwatches", description: "ساعات وأساور ذكية" },
    products: [
      { slug: "sport-smartwatch", name: "ساعة ذكية رياضية", price: 250000, stock: 8, image: "smartwatch",
        description: "ساعة ذكية بشاشة ملونة، تقيس نبض القلب والخطوات والنوم، ومقاومة للماء." },
      { slug: "fitness-band", name: "سوار لياقة ذكي", price: 95000, stock: 2, image: "smartwatch",
        description: "سوار خفيف لمتابعة النشاط اليومي والإشعارات، وبطارية تدوم أسبوعين." },
    ],
  },
  {
    category: { name: "باور بانك", slug: "power-banks", description: "بطاريات متنقلة لكل يوم" },
    products: [
      { slug: "power-bank-10000", name: "باور بانك 10000 مللي أمبير", price: 65000, stock: 25, image: "powerbank",
        description: "بطارية متنقلة صغيرة تشحن الهاتف مرتين تقريباً، بمنفذ USB-C." },
      { slug: "power-bank-20000", name: "باور بانك 20000 مللي أمبير شحن سريع", price: 110000, stock: 10, image: "powerbank",
        description: "بطارية كبيرة بقوة 22.5 واط تشحن الهاتف حتى 4 مرات، مع شاشة تعرض نسبة الشحن." },
    ],
  },
  {
    category: { name: "جرابات وحماية", slug: "cases-protection", description: "جرابات وواقيات شاشة" },
    products: [
      { slug: "silicone-case", name: "جراب سيليكون مقاوم للصدمات", price: 25000, stock: 60, image: "case",
        description: "جراب سيليكون ناعم يحمي الهاتف من الصدمات والخدوش، متوفر لأغلب الموديلات." },
      { slug: "glass-screen-protector", name: "واقي شاشة زجاج 9H", price: 15000, stock: 100, image: "screen",
        description: "واقي شاشة زجاجي بصلابة 9H، شفاف تماماً ولا يؤثر على اللمس." },
    ],
  },
  {
    category: { name: "مكبرات صوت", slug: "speakers", description: "مكبرات صوت بلوتوث" },
    products: [
      { slug: "bluetooth-speaker", name: "مكبر صوت بلوتوث محمول", price: 150000, stock: 7, image: "speaker",
        description: "مكبر صوت صغير بصوت قوي وبطارية تدوم 12 ساعة." },
      { slug: "waterproof-speaker", name: "مكبر صوت مقاوم للماء", price: 210000, stock: 4, image: "speaker",
        description: "مكبر صوت مقاوم للماء والغبار، مناسب للرحلات والبحر." },
    ],
  },
];

async function main() {
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
        if (existingProducts.some((p) => p.slug === item.slug)) continue;
        const product = await products.create({
          name: item.name,
          slug: item.slug,
          description: item.description,
          price: item.price,
          categoryId: category.id,
          imageUrl: `/images/products/${item.image}.svg`,
        });
        await inventory.set(product.id, item.stock);
        created++;
      }
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
