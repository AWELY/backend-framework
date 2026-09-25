import type { CommerceModule } from "./types";
import type { Migration } from "../db/migrations";
import { categoriesModule } from "./categories";
import { productsModule } from "./products";
import { inventoryModule } from "./inventory";
import { customersModule } from "./customers";
import { cartModule } from "./cart";
import { ordersModule } from "./orders";

/**
 * Built-in commerce modules, in dependency order: a module may only use what an
 * EARLIER one registered (Cart uses Products + Inventory; Orders uses Cart,
 * Inventory and Customers). Migration ids follow the same order (0100 ... 0600).
 */
export const coreModules: CommerceModule[] = [
  categoriesModule,
  productsModule,
  inventoryModule,
  customersModule,
  cartModule,
  ordersModule,
];

export function collectMigrations(modules: CommerceModule[]): Migration[] {
  return modules.flatMap((m) => m.migrations);
}

export { categoriesModule, productsModule, inventoryModule, customersModule, cartModule, ordersModule };
export type { CommerceModule, CommercePlugin, ModuleContext } from "./types";
