import { config as loadEnv } from "dotenv";
import type { AddressInfo } from "node:net";
import { createCommerceApp, Logger, type CommerceApp, type CommerceAppOptions } from "../../src/index";

loadEnv({ quiet: true });

export const OWNER_KEY = "test-owner-key";
export const TOKEN_SECRET = "test-token-secret-that-is-at-least-32-chars";

export interface TestApp {
  app: CommerceApp;
  base: string;
  close(): Promise<void>;
}

/**
 * A real server on a random free port, backed by a real PostgreSQL database
 * that is WIPED and re-migrated first. Refuses to run unless the database name
 * contains "test", so it can never erase development data by mistake.
 */
export async function startTestApp(
  options: Pick<CommerceAppOptions, "plugins" | "loginRateLimit" | "registrationRateLimit" | "trustProxy"> = {}
): Promise<TestApp> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (see .env.example)");
  if (!/test/i.test(new URL(url).pathname)) {
    throw new Error("Refusing to run: TEST_DATABASE_URL must point to a database whose name contains 'test'");
  }

  const app = createCommerceApp({
    databaseUrl: url,
    ownerApiKey: OWNER_KEY,
    authTokenSecret: TOKEN_SECRET,
    logger: new Logger("error"),
    ...options,
  });
  await app.pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await app.migrate();
  await app.listen(0);
  const { port } = app.server.address() as AddressInfo;
  return { app, base: `http://localhost:${port}`, close: () => app.close() };
}

export interface ApiResponse {
  status: number;
  body: any;
}

export async function api(
  base: string,
  method: string,
  path: string,
  options: { body?: unknown; owner?: boolean; token?: string; headers?: Record<string, string> } = {}
): Promise<ApiResponse> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.owner) headers["x-api-key"] = OWNER_KEY;
  if (options.token) headers["authorization"] = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(base + path, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
