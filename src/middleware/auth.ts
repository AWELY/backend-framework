import type { AppRequest } from "../engine/http/request";
import type { AppResponse } from "../engine/http/response";
import type { NextFunction } from "../engine/router";
import type { AccessControl, Permission } from "../engine/access-control";
import { UnauthorizedError, ForbiddenError } from "../engine/errors";
import { verifyToken } from "../engine/auth-token";

type Auth = NonNullable<AppRequest["auth"]>;

/**
 * The authenticator the framework actually uses. It recognises two kinds of caller:
 *
 *   X-Api-Key: <owner key>             -> { role: "owner" }
 *   Authorization: Bearer <token>      -> { role: "customer", userId }   (issued at login)
 *
 * `required` rejects anonymous requests with 401; `optional` lets them through
 * (guest checkout, public catalogue). Both reject credentials that are SENT but
 * wrong - a bad key or expired token never silently becomes "anonymous".
 */
export function createAuthenticator(options: { ownerApiKey: string; tokenSecret: string }) {
  function identify(req: AppRequest): { auth?: Auth; error?: UnauthorizedError } {
    const apiKey = req.headers["x-api-key"];
    if (apiKey !== undefined) {
      return apiKey === options.ownerApiKey
        ? { auth: { role: "owner" } }
        : { error: new UnauthorizedError("Invalid API key") };
    }
    const header = req.headers.authorization;
    if (header !== undefined) {
      const match = /^Bearer (\S+)$/.exec(header);
      const payload = match?.[1] ? verifyToken(match[1], options.tokenSecret) : null;
      if (!payload) return { error: new UnauthorizedError("Invalid or expired token") };
      return { auth: { role: payload.role, userId: payload.sub } };
    }
    return {};
  }

  return {
    required(req: AppRequest, _res: AppResponse, next: NextFunction): void {
      const { auth, error } = identify(req);
      if (error) return next(error);
      if (!auth) return next(new UnauthorizedError("Authentication required"));
      req.auth = auth;
      next();
    },
    optional(req: AppRequest, _res: AppResponse, next: NextFunction): void {
      const { auth, error } = identify(req);
      if (error) return next(error);
      if (auth) req.auth = auth;
      next();
    },
  };
}

/**
 * Authentication (who is calling) and authorization (may they do this) are
 * separate steps:
 *
 *   requireApiKey      -> authenticates the store owner via the X-Api-Key header
 *   requirePermission  -> checks req.auth.role against the AccessControl policy
 *
 * Customer authentication (logging in to an account) is added with the
 * Customers module, which needs the database; it will set req.auth the same
 * way, so requirePermission does not change.
 */

export function requireApiKey(ownerApiKey: string) {
  return function requireApiKeyMiddleware(req: AppRequest, _res: AppResponse, next: NextFunction): void {
    const provided = req.headers["x-api-key"];
    if (!provided || provided !== ownerApiKey) {
      next(new UnauthorizedError("Missing or invalid API key"));
      return;
    }
    req.auth = { role: "owner" };
    next();
  };
}

/**
 * Like requireApiKey, but a request WITHOUT the header continues anonymously.
 * A request that sends a WRONG key is still rejected, so a typo never silently
 * downgrades the owner to a public view.
 */
export function optionalApiKey(ownerApiKey: string) {
  return function optionalApiKeyMiddleware(req: AppRequest, _res: AppResponse, next: NextFunction): void {
    const provided = req.headers["x-api-key"];
    if (provided === undefined) {
      next();
      return;
    }
    if (provided !== ownerApiKey) {
      next(new UnauthorizedError("Invalid API key"));
      return;
    }
    req.auth = { role: "owner" };
    next();
  };
}

/** 401 if nobody is authenticated, 403 if they are but their role lacks the permission. */
export function requirePermission(accessControl: AccessControl, permission: Permission) {
  return function requirePermissionMiddleware(req: AppRequest, _res: AppResponse, next: NextFunction): void {
    if (!req.auth) {
      next(new UnauthorizedError("Authentication required"));
      return;
    }
    if (!accessControl.can(req.auth.role, permission)) {
      next(new ForbiddenError(`Missing permission: ${permission}`));
      return;
    }
    next();
  };
}

/** Coarser check by role name; prefer requirePermission for new routes. */
export function requireRole(role: string) {
  return function requireRoleMiddleware(req: AppRequest, _res: AppResponse, next: NextFunction): void {
    if (!req.auth) {
      next(new UnauthorizedError("Authentication required"));
      return;
    }
    if (req.auth.role !== role) {
      next(new ForbiddenError(`Requires role: ${role}`));
      return;
    }
    next();
  };
}
