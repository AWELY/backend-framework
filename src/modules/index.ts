import type { CommerceModule } from "./types";
import type { Migration } from "../db/migrations";
import { categoriesModule } from "./categories";
import { productsModule } from "./products";
import { inventoryModule } from "./inventory";
import { customersModule } from "./customers";
import { staffModule } from "./staff";
import { cartModule } from "./cart";
import { ordersModule } from "./orders";
import { deliveryModule } from "./delivery";

/**
 * الوحدات المدمجة، بترتيب الاعتماد: كل وحدة بعد الوحدات التي تحتاج خدماتها.
 * مثال: السلة تحتاج المنتجات والمخزون، والطلبات تحتاج السلة، والتوصيل يحتاج الطلبات والموظفين.
 * (ترتيب migrations لا يعتمد على هذه القائمة: كلها تُرتَّب بأرقامها.)
 */
export const coreModules: CommerceModule[] = [
  categoriesModule,
  productsModule,
  inventoryModule,
  customersModule,
  staffModule,
  cartModule,
  ordersModule,
  deliveryModule,
];

/** كل migrations الوحدات في قائمة واحدة (runMigrations يرتبها). */
export function collectMigrations(modules: CommerceModule[]): Migration[] {
  return modules.flatMap((m) => m.migrations);
}

export {
  categoriesModule,
  productsModule,
  inventoryModule,
  customersModule,
  staffModule,
  cartModule,
  ordersModule,
  deliveryModule,
};
export type { CommerceModule, CommercePlugin, ModuleContext } from "./types";
