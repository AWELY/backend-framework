/**
 * Public library entry point: what a project that installs this framework
 * (`require("commerce-framework")`) actually gets. Nothing here has a side
 * effect - importing this file does not start a server or open a database
 * connection; callers wire those up themselves (see dev-server.ts in this
 * repo for a worked example, and cli/templates/index.js.template for what a
 * generated project looks like).
 */

export { Router } from "./engine/router";
export type { Handler, NextFunction, HttpMethod, RouteMatch } from "./engine/router";

export { createServer } from "./engine/http/server";
export type { ServerOptions } from "./engine/http/server";

export type { AppRequest } from "./engine/http/request";
export type { AppResponse } from "./engine/http/response";

export { runPipeline } from "./engine/middleware-pipeline";

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

export { validate } from "./engine/validation";
export type { Schema, FieldRule, Infer, FieldIssue } from "./engine/validation";

export { loadConfig } from "./engine/config";
export type { AppConfig, LogLevel } from "./engine/config";

export { Logger } from "./engine/logger";
export { FailureLimiter } from "./engine/rate-limiter";
export type { LimiterOptions } from "./engine/rate-limiter";
export { clientIp } from "./engine/http/client-ip";

export { Container } from "./container/container";
export { createToken } from "./container/tokens";
export type { Token } from "./container/tokens";

export { cors } from "./middleware/cors";
export { requestLogger } from "./middleware/request-logger";
export { AccessControl, DEFAULT_ROLES } from "./engine/access-control";
export type { Permission, RolePermissions } from "./engine/access-control";

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

export { createPool, pingDatabase } from "./db/connection";
export { Repository } from "./db/repository";
export type { Queryable, ListOptions } from "./db/repository";
export { withTransaction } from "./db/transaction";
export { runMigrations } from "./db/migrations";
export type { Migration } from "./db/migrations";
export { translateDbError } from "./db/errors";
export { isUuid } from "./db/ids";

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
// DI tokens, so store projects and plugins can resolve module services.
export { CATEGORIES_REPOSITORY } from "./modules/categories/categories.repository";
export { PRODUCTS_REPOSITORY } from "./modules/products/products.repository";
export { INVENTORY_REPOSITORY } from "./modules/inventory/inventory.repository";
export { CUSTOMERS_REPOSITORY } from "./modules/customers/customers.repository";
export { CART_REPOSITORY } from "./modules/cart/cart.repository";
export { ORDERS_REPOSITORY } from "./modules/orders/orders.repository";
export { ORDERS_SERVICE } from "./modules/orders/orders.service";
export type { Order, OrderItem, OrderStatus, PaymentStatus } from "./modules/orders/orders.schema";

export { cashOnDelivery, flatRateShipping } from "./plugins";
export type { FlatRateShippingOptions } from "./plugins";

export { createCommerceApp } from "./app";
export type { CommerceApp, CommerceAppOptions } from "./app";
