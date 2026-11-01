/**
 * نقطة الدخول العامة للمكتبة: ما يحصل عليه أي مشروع يثبّت هذا الإطار ويكتب
 * require("maa").
 *
 * لا شيء هنا له أثر جانبي: استيراد هذا الملف لا يشغّل خادماً ولا يفتح اتصالاً بالقاعدة.
 * المشروع هو من يقرر متى يشغّلهما. أمثلة عملية:
 *   - src/dev-server.ts في هذا المستودع.
 *   - cli/templates/index.js.template: شكل المشروع الذي تنشئه أداة CLI.
 *
 * هذه القائمة هي "الواجهة العامة" (Public API) للإطار: ما ليس فيها يبقى تفصيلاً داخلياً
 * يمكن تغييره دون أن تتعطل المتاجر التي تستخدم الإطار. سياسة النسخ في docs/VERSIONING.md.
 */

// المحرك: التوجيه.
export { Router } from "./engine/router";
export type { Handler, NextFunction, HttpMethod, RouteMatch, RouteInfo } from "./engine/router";
export { withMeta } from "./engine/route-meta";
export type { RouteMeta } from "./engine/route-meta";

// المحرك: خادم HTTP وشكل الطلب والرد.
export { createServer, DEFAULT_BODY_LIMIT_BYTES } from "./engine/http/server";
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
  MethodNotAllowedError,
  ConflictError,
  PreconditionFailedError,
  PayloadTooLargeError,
  TooManyRequestsError,
  BadGatewayError,
  ServiceUnavailableError,
  ErrorCodes,
  toErrorResponse,
} from "./engine/errors";
export type { ErrorResponse } from "./engine/errors";

// المحرك: التحقق من المدخلات.
export { validate, validateQuery } from "./engine/validation";
export type { Schema, FieldRule, Infer, FieldIssue, InputSpec } from "./engine/validation";

// المحرك: الإعدادات، والسجل، والمقاييس، وحد المحاولات، وعنوان العميل، و OpenAPI.
export { loadConfig } from "./engine/config";
export type { AppConfig, LogLevel } from "./engine/config";

export { Logger, redactSensitive } from "./engine/logger";
export type { LoggerOptions, LogFormat } from "./engine/logger";
export { MetricsRegistry, Counter, Histogram, Gauge } from "./engine/metrics";
export { FailureLimiter } from "./engine/rate-limiter";
export type { Limiter, LimiterOptions } from "./engine/rate-limiter";
export { clientIp } from "./engine/http/client-ip";
export { generateOpenApi } from "./engine/openapi";

// حقن الاعتماديات.
export { Container } from "./container/container";
export { createToken } from "./container/tokens";
export type { Token } from "./container/tokens";

// المعالجات الوسيطة والصلاحيات.
export { cors } from "./middleware/cors";
export { securityHeaders } from "./middleware/security-headers";
export { requestLogger } from "./middleware/request-logger";
export { httpMetrics } from "./middleware/metrics";
export { idempotency } from "./middleware/idempotency";
export type { IdempotencyStore } from "./middleware/idempotency";
export { auditTrail } from "./middleware/audit";
export type { AuditEntry, AuditSink } from "./middleware/audit";
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
export type { SessionVerifier, AuthenticatorOptions } from "./middleware/auth";
export { hashPassword, verifyPassword } from "./engine/password";
export { signToken, verifyToken } from "./engine/auth-token";
export type { TokenPayload } from "./engine/auth-token";
export { verifyWebhookSignature, signWebhookPayload, hmacSha256Hex, safeEqual } from "./engine/webhook";
export { validateBody, withInput } from "./middleware/validate";
export type { ValidatedInput } from "./middleware/validate";

// طبقة البيانات.
export { createPool, pingDatabase } from "./db/connection";
export type { DatabaseOptions } from "./db/connection";
export { Repository } from "./db/repository";
export type { Queryable, ListOptions, ListPage } from "./db/repository";
export { withTransaction } from "./db/transaction";
export type { TransactionOptions } from "./db/transaction";
export { runMigrations, pendingMigrations } from "./db/migrations";
export type { Migration } from "./db/migrations";
export { translateDbError } from "./db/errors";
export { isUuid } from "./db/ids";

// وقت التشغيل: الجلسات، والأحداث، والمهام، والتدقيق، والإيقاف اللطيف.
export { runtimeMigrations } from "./runtime/migrations";
export { SessionManager } from "./runtime/sessions";
export type { PrincipalType, IssuedSession } from "./runtime/sessions";
export { EventOutbox } from "./runtime/outbox";
export type { EventMeta } from "./runtime/outbox";
export { JobQueue } from "./runtime/jobs";
export type { JobHandler, JobContext } from "./runtime/jobs";
export { AuditLog } from "./runtime/audit-log";
export type { AuditRecord } from "./runtime/audit-log";
export { PostgresLimiter } from "./runtime/rate-limit";
export { installShutdownHandlers } from "./runtime/lifecycle";

// الوحدات التجارية ونظام الإضافات.
export {
  coreModules,
  collectMigrations,
  categoriesModule,
  productsModule,
  inventoryModule,
  customersModule,
  staffModule,
  cartModule,
  ordersModule,
  deliveryModule,
} from "./modules";
export type { CommerceModule, CommercePlugin, ModuleContext } from "./modules";
export type { EventPublisher, RateLimiters } from "./modules/types";
export { ExtensionRegistry } from "./modules/extensions";
export type {
  ShippingProvider,
  ShippingQuoteInput,
  PaymentProvider,
  PaymentResult,
  PriceAdjuster,
  PriceAdjustment,
  PricingContext,
  CommerceEvents,
  Listener,
} from "./modules/extensions";
export { actorOf, sendPage, found, etag, expectedVersion, PAGINATION_QUERY, ID_PARAMS, SYSTEM_ACTOR } from "./modules/shared";
export type { Actor } from "./modules/shared";
// رموز الـ DI، لتستطيع مشاريع المتاجر والإضافات طلب خدمات الوحدات من الحاوية.
export { CATEGORIES_REPOSITORY } from "./modules/categories/categories.repository";
export { PRODUCTS_REPOSITORY, ProductsRepository } from "./modules/products/products.repository";
export { INVENTORY_REPOSITORY } from "./modules/inventory/inventory.repository";
export { CUSTOMERS_REPOSITORY } from "./modules/customers/customers.repository";
export { STAFF_REPOSITORY } from "./modules/staff/staff.repository";
export { CART_REPOSITORY } from "./modules/cart/cart.repository";
export { ORDERS_REPOSITORY } from "./modules/orders/orders.repository";
export { ORDERS_SERVICE } from "./modules/orders/orders.service";
export type { OrdersService, Quote, CheckoutResult } from "./modules/orders/orders.service";
export { ORDER_TIMELINE } from "./modules/orders/orders.timeline";
export { DELIVERY_SERVICE } from "./modules/delivery/delivery.service";
export type {
  Order,
  OrderItem,
  OrderStatus,
  PaymentStatus,
  Refund,
  OrderEvent,
} from "./modules/orders/orders.schema";
export type { Product, Variant } from "./modules/products/products.schema";
export type { Customer } from "./modules/customers/customers.schema";
export type { Staff } from "./modules/staff/staff.schema";
export type { Delivery, DeliveryStatus } from "./modules/delivery/delivery.schema";
export type { Cart, CartLine } from "./modules/cart/cart.schema";

// الإضافات الجاهزة.
export { cashOnDelivery, flatRateShipping, cityRateShipping, coupons, percentageTax } from "./plugins";
export type { FlatRateShippingOptions, CityRateShippingOptions, Coupon, PercentageTaxOptions } from "./plugins";

// نقطة التجميع: الاستدعاء الوحيد الذي يحتاجه المتجر.
export { createCommerceApp, optionsFromConfig } from "./app";
export type { CommerceApp, CommerceAppOptions, RateLimitSetting } from "./app";
