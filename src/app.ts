import type { Server } from "node:http";
import type { Pool } from "pg";
import { Router } from "./engine/router";
import { createServer } from "./engine/http/server";
import { Logger } from "./engine/logger";
import { AccessControl } from "./engine/access-control";
import { Container } from "./container/container";
import { cors } from "./middleware/cors";
import { requestLogger } from "./middleware/request-logger";
import { createAuthenticator } from "./middleware/auth";
import { signToken } from "./engine/auth-token";
import { createPool, pingDatabase } from "./db/connection";
import { runMigrations } from "./db/migrations";
import { coreModules, collectMigrations } from "./modules";
import type { CommerceModule, CommercePlugin, ModuleContext } from "./modules/types";
import { ExtensionRegistry } from "./modules/extensions";
import { FailureLimiter, type LimiterOptions } from "./engine/rate-limiter";
import { clientIp } from "./engine/http/client-ip";

export interface CommerceAppOptions {
  databaseUrl: string;
  ownerApiKey: string;
  /** Signs customer login tokens. */
  authTokenSecret: string;
  /** How long a customer login token stays valid. Default: 7 days. */
  tokenTtlSeconds?: number;
  corsOrigin?: string;
  logger?: Logger;
  /** Defaults to every built-in module. */
  modules?: CommerceModule[];
  /** Set up after all modules, e.g. [cashOnDelivery(), flatRateShipping({ rate: 10000 })]. */
  plugins?: CommercePlugin[];
  accessControl?: AccessControl;
  /**
   * Failed-login limit, per IP and per email. Default: 10 failures per 15 minutes.
   * `false` turns it off (not recommended outside tests/benchmarks).
   */
  loginRateLimit?: Pick<LimiterOptions, "maxFailures" | "windowSeconds"> | false;
  /**
   * Account registrations per IP (every attempt that reaches password hashing).
   * Default: 5 per hour. `false` turns it off.
   */
  registrationRateLimit?: Pick<LimiterOptions, "maxFailures" | "windowSeconds"> | false;
  /** Read the client IP from X-Forwarded-For. Only when behind ONE trusted reverse proxy. */
  trustProxy?: boolean;
}

export interface CommerceApp {
  server: Server;
  router: Router;
  container: Container;
  pool: Pool;
  logger: Logger;
  extensions: ExtensionRegistry;
  /** Applies any migrations of the registered modules that are not applied yet. */
  migrate(): Promise<string[]>;
  listen(port: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * The one call a store project needs: builds the pool, DI container, router,
 * auth and every module, and returns a server ready to listen. This is what
 * makes "a working store API in a few lines" true for generated projects.
 */
export function createCommerceApp(options: CommerceAppOptions): CommerceApp {
  const logger = options.logger ?? new Logger("info");
  const modules = options.modules ?? coreModules;
  const plugins = options.plugins ?? [];
  const pool = createPool(options.databaseUrl);
  const container = new Container();
  const router = new Router();
  const accessControl = options.accessControl ?? new AccessControl();
  const extensions = new ExtensionRegistry(logger);

  const auth = createAuthenticator({ ownerApiKey: options.ownerApiKey, tokenSecret: options.authTokenSecret });
  const tokenTtl = options.tokenTtlSeconds ?? 7 * 24 * 60 * 60;
  const loginLimiter =
    options.loginRateLimit === false
      ? null
      : new FailureLimiter(options.loginRateLimit ?? { maxFailures: 10, windowSeconds: 15 * 60 });
  const registrationLimiter =
    options.registrationRateLimit === false
      ? null
      : new FailureLimiter(options.registrationRateLimit ?? { maxFailures: 5, windowSeconds: 60 * 60 });
  const trustProxy = options.trustProxy ?? false;

  const context: ModuleContext = {
    router,
    container,
    pool,
    accessControl,
    logger,
    authenticate: auth.required,
    authenticateOptional: auth.optional,
    issueCustomerToken: (customerId) =>
      signToken({ sub: customerId, role: "customer" }, options.authTokenSecret, tokenTtl),
    extensions,
    loginLimiter,
    registrationLimiter,
    clientIp: (req) => clientIp(req, trustProxy),
  };

  router.get("/health", async (_req, res) => {
    await pingDatabase(pool);
    res.json({ status: "ok", database: "ok" });
  });

  for (const module of modules) module.register(context);
  // Plugins come last so they can use any module's services and routes.
  for (const plugin of plugins) plugin.setup(context);

  const migrations = [...collectMigrations(modules), ...plugins.flatMap((p) => p.migrations ?? [])];

  const server = createServer({
    router,
    globalMiddleware: [cors(options.corsOrigin ?? "*"), requestLogger(logger)],
    logger,
  });

  return {
    server,
    router,
    container,
    pool,
    logger,
    extensions,
    migrate: () => runMigrations(pool, migrations, (m) => logger.info(m)),
    // A busy port rejects the promise (instead of crashing with an unhandled 'error' event).
    listen: (port) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, () => {
          server.off("error", reject);
          resolve();
        });
      }),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    },
  };
}
