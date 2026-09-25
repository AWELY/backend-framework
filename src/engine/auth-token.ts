import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed, expiring access tokens (HMAC-SHA256) - the same idea as a JWT, but
 * one fixed algorithm and no library. The server keeps no session table: the
 * signature proves the server issued the token, and `exp` limits its lifetime.
 *
 * Known limit of stateless tokens: one cannot be revoked before it expires
 * (logging out = the client deletes it). Short lifetimes keep that window small.
 *
 * Format: base64url(JSON payload) + "." + base64url(HMAC of that first part)
 */

export interface TokenPayload {
  /** Subject: the customer id. */
  sub: string;
  role: string;
  /** Expiry, in seconds since the Unix epoch. */
  exp: number;
}

function sign(body: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

export function signToken(
  claims: { sub: string; role: string },
  secret: string,
  ttlSeconds: number,
  now: number = Date.now()
): string {
  const payload: TokenPayload = { ...claims, exp: Math.floor(now / 1000) + ttlSeconds };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, secret).toString("base64url")}`;
}

/** The payload if the signature is valid and the token has not expired; otherwise null. */
export function verifyToken(token: string, secret: string, now: number = Date.now()): TokenPayload | null {
  const [body, signature, ...rest] = token.split(".");
  if (!body || !signature || rest.length > 0) return null;

  const expected = sign(body, secret);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const p = payload as Partial<TokenPayload>;
  if (typeof p.sub !== "string" || typeof p.role !== "string" || typeof p.exp !== "number") return null;
  if (p.exp * 1000 <= now) return null;
  return { sub: p.sub, role: p.role, exp: p.exp };
}
