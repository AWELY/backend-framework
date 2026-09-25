import type { IncomingMessage } from "node:http";

/**
 * What a route handler actually receives: Node's IncomingMessage, plus the fields
 * the router and body-reader fill in before a handler ever sees the request.
 */
export interface AppRequest extends IncomingMessage {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  /** Set by middleware/auth.ts once a request is authenticated. */
  auth?: { role: string; userId?: string };
}
