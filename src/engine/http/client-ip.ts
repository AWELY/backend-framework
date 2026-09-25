import type { IncomingMessage } from "node:http";

/**
 * The caller's IP address.
 *
 * Without a reverse proxy, the TCP peer address is the client. Behind ONE
 * trusted reverse proxy (e.g. nginx on the same server), every connection comes
 * from the proxy, so the real client is read from X-Forwarded-For - and from its
 * LAST entry, the one the proxy itself appended. Earlier entries are whatever
 * the client chose to send, so trusting them would let anyone pick their own IP
 * and dodge the login rate limit. Leave `trustProxy` off unless a proxy is
 * actually in front of the app.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const header = req.headers["x-forwarded-for"];
    const value = Array.isArray(header) ? header[header.length - 1] : header;
    const last = value?.split(",").pop()?.trim();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
}
