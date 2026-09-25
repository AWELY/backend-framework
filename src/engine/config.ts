/**
 * Reads configuration from environment variables. Nothing else in the framework
 * touches `process.env` directly - every other module receives config as plain
 * data, which keeps them testable without real env vars.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AppConfig {
  env: string;
  port: number;
  ownerApiKey: string;
  /** Signs customer login tokens. Changing it logs every customer out. */
  authTokenSecret: string;
  logLevel: LogLevel;
  corsOrigin: string;
  databaseUrl: string;
  /** true only when the app runs behind ONE trusted reverse proxy (e.g. nginx). */
  trustProxy: boolean;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

/**
 * A secret must be long and must not be the placeholder from .env.example, so
 * a project can never start up with a guessable owner key or signing secret.
 */
function secret(name: string): string {
  const value = required(name);
  if (value.startsWith("change-me") || value.length < 32) {
    throw new Error(
      `${name} must be a random value of at least 32 characters. Generate one with:\n` +
        `  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
    );
  }
  return value;
}

export function loadConfig(): AppConfig {
  return {
    env: process.env.NODE_ENV ?? "development",
    port: Number(process.env.PORT ?? 3000),
    ownerApiKey: secret("OWNER_API_KEY"),
    authTokenSecret: secret("AUTH_TOKEN_SECRET"),
    logLevel: (process.env.LOG_LEVEL as LogLevel) ?? "info",
    corsOrigin: process.env.CORS_ORIGIN ?? "*",
    databaseUrl: required("DATABASE_URL"),
    trustProxy: process.env.TRUST_PROXY === "true",
  };
}
