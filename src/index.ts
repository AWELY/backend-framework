/**
 * نقطة الدخول العامة للمكتبة: ما يحصل عليه أي مشروع يثبّت هذا الإطار ويكتب
 * require("commerce-framework").
 *
 * لا شيء هنا له أثر جانبي: استيراد هذا الملف لا يشغّل خادماً ولا يفتح اتصالاً بالقاعدة.
 * المشروع هو من يقرر متى يشغّلهما. أمثلة عملية:
 *   - src/dev-server.ts في هذا المستودع.
 *   - cli/templates/index.js.template: شكل المشروع الذي تنشئه أداة CLI.
 *
 * هذه القائمة هي "الواجهة العامة" (Public API) للإطار: ما ليس فيها يبقى تفصيلاً داخلياً
 * يمكن تغييره دون أن تتعطل المتاجر التي تستخدم الإطار.
 */

// المحرك: التوجيه.
export { Router } from "./engine/router";
export type { Handler, NextFunction, HttpMethod, RouteMatch } from "./engine/router";

// المحرك: خادم HTTP وشكل الطلب والرد.
export { createServer } from "./engine/http/server";
export type { ServerOptions } from "./engine/http/server";

export type { AppRequest } from "./engine/http/request";
export type { AppResponse } from "./engine/http/response";

// المحرك: سلسلة المعالجات.
export { runPipeline } from "./engine/middleware-pipeline";

// المحرك: الأخطاء المركزية.
export {
  AppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  TooManyRequestsError,
  toErrorResponse,
} from "./engine/errors";
export type { ErrorResponse } from "./engine/errors";

// المحرك: التحقق من المدخلات.
export { validate } from "./engine/validation";
export type { Schema, FieldRule, Infer, FieldIssue } from "./engine/validation";

// المحرك: الإعدادات، والسجل، وحد المحاولات، وعنوان العميل.
export { loadConfig } from "./engine/config";
export type { AppConfig, LogLevel } from "./engine/config";

export { Logger } from "./engine/logger";
export { FailureLimiter } from "./engine/rate-limiter";
export type { LimiterOptions } from "./engine/rate-limiter";
export { clientIp } from "./engine/http/client-ip";

// حقن الاعتماديات.
export { Container } from "./container/container";
export { createToken } from "./container/tokens";
export type { Token } from "./container/tokens";

// المعالجات الوسيطة والصلاحيات.
export { cors } from "./middleware/cors";
export { requestLogger } from "./middleware/request-logger";
export { AccessControl, DEFAULT_ROLES } from "./engine/access-control";
export type { Permission, RolePermissions } from "./engine/access-control";

// المصادقة وأدوات الأمان.
export {
  createAuthenticator,
  requireApiKey,
  optionalApiKey,
  requirePermission,
  requireRole,
} from "./middleware/auth";
export { hashPassword, verifyPassword } from "./engine/password";
export { signToken, verifyToken } from "./engine/auth-token";
export type { TokenPayload } from "./engine/auth-token";
export { validateBody } from "./middleware/validate";

// طبقة البيانات.
export { createPool, pingDatabase } from "./db/connection";
export { Repository } from "./db/repository";
export type { Queryable, ListOptions } from "./db/repository";
export { withTransaction } from "./db/transaction";
export { runMigrations } from "./db/migrations";
export type { Migration } from "./db/migrations";
export { translateDbError } from "./db/errors";
export { isUuid } from "./db/ids";

// الوحدات التجارية ونظام الإضافات.
export {
  coreModules,
  collectMigrations,
  categoriesModule,
  productsModule,
  inventoryModule,
  customersModule,
  cartModule,
  ordersModule,
} from "./modules";
export type { CommerceModule, CommercePlugin, ModuleContext } from "./modules";
export { ExtensionRegistry } from "./modules/extensions";
export type {
  ShippingProvider,
  ShippingQuoteInput,
  PaymentProvider,
  PaymentResult,
  CommerceEvents,
} from "./modules/extensions";
// رموز الـ DI، لتستطيع مشاريع المتاجر والإضافات طلب خدمات الوحدات من الحاوية.
export { CATEGORIES_REPOSITORY } from "./modules/categories/categories.repository";
export { PRODUCTS_REPOSITORY } from "./modules/products/products.repository";
export { INVENTORY_REPOSITORY } from "./modules/inventory/inventory.repository";
export { CUSTOMERS_REPOSITORY } from "./modules/customers/customers.repository";
export { CART_REPOSITORY } from "./modules/cart/cart.repository";
export { ORDERS_REPOSITORY } from "./modules/orders/orders.repository";
export { ORDERS_SERVICE } from "./modules/orders/orders.service";
export type { Order, OrderItem, OrderStatus, PaymentStatus } from "./modules/orders/orders.schema";

// الإضافات الجاهزة.
export { cashOnDelivery, flatRateShipping, cityRateShipping } from "./plugins";
export type { FlatRateShippingOptions, CityRateShippingOptions } from "./plugins";

// نقطة التجميع: الاستدعاء الوحيد الذي يحتاجه المتجر.
export { createCommerceApp } from "./app";
export type { CommerceApp, CommerceAppOptions } from "./app";
