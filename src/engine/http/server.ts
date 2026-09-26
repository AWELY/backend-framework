import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import type { Router, Handler } from "../router";
import type { AppRequest } from "./request";
import { enhanceResponse } from "./response";
import { runPipeline } from "../middleware-pipeline";
import type { Logger } from "../logger";
import { NotFoundError, ValidationError, toErrorResponse } from "../errors";

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      const contentType = req.headers["content-type"] ?? "";
      if (contentType.includes("application/json")) {
        try {
          resolve(raw.length ? JSON.parse(raw) : undefined);
        } catch {
          // A malformed body is the client's mistake (400), not a server failure (500).
          reject(new ValidationError("Malformed JSON body"));
        }
      } else {
        resolve(raw);
      }
    });
    req.on("error", reject);
  });
}

export interface ServerOptions {
  router: Router;
  /** Applied to every request, before route-specific middleware. */
  globalMiddleware: Handler[];
  logger: Logger;
}

/**
 * Wires a Router to a real Node HTTP server: parses the URL, reads and parses the
 * body, finds a matching route, and runs [globalMiddleware, routeMiddleware,
 * handler] through the pipeline. Any error - thrown, passed to next(err), or from
 * a missing route / bad body - ends up in one place: toErrorResponse (engine/errors.ts).
 */
export function createServer({ router, globalMiddleware, logger }: ServerOptions) {
  return createHttpServer(async (rawReq, rawRes) => {
    const res = enhanceResponse(rawRes);
    const req = rawReq as AppRequest;

    const onError = (err: unknown): void => {
      const { statusCode, body, headers } = toErrorResponse(err);
      if (statusCode >= 500) {
        logger.error("Unhandled error", {
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      }
      if (res.headersSent) return;
      for (const [name, value] of Object.entries(headers ?? {})) res.setHeader(name, value);
      res.status(statusCode).json(body);
    };

    try {
      const url = new URL(rawReq.url ?? "/", `http://${rawReq.headers.host ?? "localhost"}`);
      req.query = url.searchParams;
      req.params = {};
      req.body = undefined;

      // Global middleware ALWAYS runs first - even when no route matches and
      // before the body is read. Otherwise a browser's CORS preflight (OPTIONS,
      // which has no route) would get a bare 404, and error responses (404,
      // malformed JSON) would lack CORS headers, so a website on another origin
      // could neither send JSON nor read the error.
      const readBodyStep: Handler = async (_req, _res, next) => {
        req.body = await readBody(rawReq);
        next();
      };
      const match = router.match(rawReq.method ?? "GET", url.pathname);
      const chain: Handler[] = match
        ? [...globalMiddleware, readBodyStep, ...match.route.middleware, match.route.handler]
        : [
            ...globalMiddleware,
            () => {
              throw new NotFoundError(`No route for ${rawReq.method} ${url.pathname}`);
            },
          ];
      if (match) req.params = match.params;
      runPipeline(chain, req, res, onError);
    } catch (err) {
      onError(err);
    }
  });
}
