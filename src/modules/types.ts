import type { Pool } from "pg";
import type { Router, Handler } from "../engine/router";
import type { Container } from "../container/container";
import type { AccessControl } from "../engine/access-control";
import type { Logger } from "../engine/logger";
import type { Migration } from "../db/migrations";
import type { ExtensionRegistry } from "./extensions";
import type { FailureLimiter } from "../engine/rate-limiter";
import type { AppRequest } from "../engine/http/request";

/** Everything a module is handed when it registers - modules never create these themselves. */
export interface ModuleContext {
  router: Router;
  container: Container;
  pool: Pool;
  accessControl: AccessControl;
  logger: Logger;
  /** Rejects the request with 401 unless it is authenticated. */
  authenticate: Handler;
  /** Identifies the caller if credentials are sent, but lets anonymous requests through. */
  authenticateOptional: Handler;
  /** Issues a signed login token for a customer (the signing secret itself is never handed out). */
  issueCustomerToken(customerId: string): string;
  /** Shipping/payment providers and event listeners contributed by plugins. */
  extensions: ExtensionRegistry;
  /** Failed-login counter per IP and per email; null when rate limiting is turned off. */
  loginLimiter: FailureLimiter | null;
  /** Registration-attempt counter per IP; null when turned off. */
  registrationLimiter: FailureLimiter | null;
  /** The caller's IP (honours X-Forwarded-For only when trustProxy is on). */
  clientIp(req: AppRequest): string;
}

/**
 * The contract every commerce module (and, later, every plugin) follows:
 * a name, the SQL migrations for its tables, and a register() that wires its
 * repositories into the DI container and its routes into the router.
 */
export interface CommerceModule {
  name: string;
  migrations: Migration[];
  register(context: ModuleContext): void;
}

/**
 * A plugin: set up AFTER every module, so it can use any module's services
 * (e.g. resolve ORDERS_SERVICE) and register providers, listeners and extra
 * routes. Plugin migration ids should start at "9000_" so they always run
 * after the built-in ones.
 */
export interface CommercePlugin {
  name: string;
  migrations?: Migration[];
  setup(context: ModuleContext): void;
}
