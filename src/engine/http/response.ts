import type { ServerResponse } from "node:http";

/**
 * Node's ServerResponse plus three convenience methods every handler wants.
 * `enhanceResponse` attaches them to the real response object instead of wrapping
 * it, so handlers still get every native ServerResponse method (headers, streaming,
 * etc.) for free.
 */
export interface AppResponse extends ServerResponse {
  status(code: number): AppResponse;
  json(data: unknown): void;
  send(body: string): void;
}

export function enhanceResponse(res: ServerResponse): AppResponse {
  const appRes = res as AppResponse;

  appRes.status = (code: number): AppResponse => {
    appRes.statusCode = code;
    return appRes;
  };

  appRes.json = (data: unknown): void => {
    appRes.setHeader("Content-Type", "application/json; charset=utf-8");
    appRes.end(JSON.stringify(data));
  };

  appRes.send = (body: string): void => {
    if (!appRes.hasHeader("Content-Type")) {
      appRes.setHeader("Content-Type", "text/plain; charset=utf-8");
    }
    appRes.end(body);
  };

  return appRes;
}
