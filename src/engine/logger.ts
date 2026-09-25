/**
 * A minimal leveled logger with zero dependencies (no pino/winston - the project's
 * "few, individually justified, light dependencies" rule applies here too: a
 * console logger with timestamps and level filtering is enough for this project's
 * scale, and pulling in a logging library would be unjustified weight).
 */

import type { LogLevel } from "./config";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  constructor(private readonly minLevel: LogLevel = "info") {}

  private write(level: LogLevel, message: string, meta?: unknown): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.minLevel]) return;
    const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
    const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    if (meta !== undefined) sink(line, meta);
    else sink(line);
  }

  debug(message: string, meta?: unknown): void {
    this.write("debug", message, meta);
  }
  info(message: string, meta?: unknown): void {
    this.write("info", message, meta);
  }
  warn(message: string, meta?: unknown): void {
    this.write("warn", message, meta);
  }
  error(message: string, meta?: unknown): void {
    this.write("error", message, meta);
  }
}
