const { CATEGORIES_REPOSITORY, PRODUCTS_REPOSITORY, INVENTORY_REPOSITORY } = require("commerce-framework");
const { buildApp } = require("./app");

// Sample catalogue for a small Libyan store. Prices in dirhams (1 LYD = 1000).
const CATALOGUE = [
  {
    category: { name: "Coffee & Tea - قهوة وشاي", slug: "coffee-tea" },
    products: [
      { name: "Arabic coffee with cardamom 250g - قهوة عربية بالهيل", slug: "arabic-coffee-250g", price: 18500, stock: 40 },
      { name: "Green tea 100 bags - شاي أخضر", slug: "green-tea-100", price: 12000, stock: 25 },
      { name: "Moroccan mint tea 200g - شاي بالنعناع", slug: "mint-tea-200g", price: 9500, stock: 0 },
    ],
  },
  {
    category: { name: "Kitchenware - أدوات مطبخ", slug: "kitchenware" },
    products: [
      { name: "Copper coffee pot (dallah) - دلة نحاس", slug: "copper-dallah", price: 95000, stock: 6 },
      { name: "Tea glasses, set of 6 - طقم كاسات شاي", slug: "tea-glasses-6", price: 35000, stock: 15 },
    ],
  },
  {
    category: { name: "Sweets - حلويات", slug: "sweets" },
    products: [
      { name: "Makroudh with dates 1kg - مقروض بالتمر", slug: "makroudh-1kg", price: 45000, stock: 12 },
      { name: "Bsisa 500g - بسيسة", slug: "bsisa-500g", price: 22000, stock: 20 },
    ],
  },
];

/** Idempotent: running it twice does not duplicate anything (matches on slug). */
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
          price: item.price,
          categoryId: category.id,
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
