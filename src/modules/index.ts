import type { CommerceModule } from "./types";
import type { Migration } from "../db/migrations";
import { categoriesModule } from "./categories";
import { productsModule } from "./products";
import { inventoryModule } from "./inventory";
import { customersModule } from "./customers";
import { cartModule } from "./cart";
import { ordersModule } from "./orders";

/**
 * الوحدات التجارية الست المدمجة في الإطار، بترتيب اعتمادها على بعضها.
 *
 * القاعدة: الوحدة تستطيع استخدام ما سجّلته وحدة قبلها فقط، لأن createCommerceApp يسجّلها
 * بهذا الترتيب. السلة تستخدم المنتجات والمخزون، والطلبات تستخدم السلة والمخزون والزبائن،
 * فيجب أن تأتي بعدها.
 *
 * أرقام الـ migrations تتبع نفس الترتيب (0100 للأقسام ... 0600 للطلبات)، لأن جداول
 * الوحدات اللاحقة تشير إلى جداول السابقة (مثل products.category_id يشير إلى categories).
 */
export const coreModules: CommerceModule[] = [
  categoriesModule,
  productsModule,
  inventoryModule,
  customersModule,
  cartModule,
  ordersModule,
];

/** يجمع migrations كل الوحدات في قائمة واحدة. flatMap تدمج قوائم الوحدات في قائمة مسطحة. */
export function collectMigrations(modules: CommerceModule[]): Migration[] {
  return modules.flatMap((m) => m.migrations);
}

// نصدّر كل وحدة منفردة أيضاً، لمن يريد تركيب الإطار بوحدات مختارة فقط.
export { categoriesModule, productsModule, inventoryModule, customersModule, cartModule, ordersModule };
export type { CommerceModule, CommercePlugin, ModuleContext } from "./types";
