import type { AppRequest } from "./http/request";
import type { AppResponse } from "./http/response";

export type NextFunction = (err?: unknown) => void;
export type Handler = (req: AppRequest, res: AppResponse, next: NextFunction) => void | Promise<void>;
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface Route {
  method: HttpMethod;
  pattern: RegExp;
  paramNames: string[];
  /** Every handler except the last one, run as middleware before it. */
  middleware: Handler[];
  handler: Handler;
}

export interface RouteMatch {
  route: Route;
  params: Record<string, string>;
}

/**
 * Turns "/products/:id" into a RegExp that captures the ":id" segment, without
 * pulling in a path-matching library - the framework's routes are simple enough
 * (static segments + single ":param" segments) that a small hand-rolled compiler
 * is both lighter and more transparent than a dependency.
 */
function compilePath(path: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const segments = path
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        paramNames.push(segment.slice(1));
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    });
  return { pattern: new RegExp(`^${segments.join("/")}/?$`), paramNames };
}

export class Router {
  private readonly routes: Route[] = [];

  private add(method: HttpMethod, path: string, handlers: Handler[]): void {
    if (handlers.length === 0) {
      throw new Error(`Route ${method} ${path} needs at least one handler`);
    }
    const { pattern, paramNames } = compilePath(path);
    const handler = handlers[handlers.length - 1] as Handler;
    const middleware = handlers.slice(0, -1);
    this.routes.push({ method, pattern, paramNames, middleware, handler });
  }

  get(path: string, ...handlers: Handler[]): void {
    this.add("GET", path, handlers);
  }
  post(path: string, ...handlers: Handler[]): void {
    this.add("POST", path, handlers);
  }
  put(path: string, ...handlers: Handler[]): void {
    this.add("PUT", path, handlers);
  }
  patch(path: string, ...handlers: Handler[]): void {
    this.add("PATCH", path, handlers);
  }
  delete(path: string, ...handlers: Handler[]): void {
    this.add("DELETE", path, handlers);
  }

  match(method: string, pathname: string): RouteMatch | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const result = route.pattern.exec(pathname);
      if (!result) continue;
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(result[i + 1] ?? "");
      });
      return { route, params };
    }
    return null;
  }
}
