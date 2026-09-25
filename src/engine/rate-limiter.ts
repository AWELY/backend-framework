/**
 * Counts FAILURES per key (e.g. "ip:1.2.3.4", "email:a@b.ly") in a fixed time
 * window, in memory - no Redis, consistent with the single-process design.
 * Trade-off: counters reset when the process restarts.
 *
 * Callers check isBlocked() BEFORE doing expensive work (password hashing), so
 * once a key is blocked, further attempts cost almost nothing - that is what
 * stops a login flood from exhausting the server.
 */

export interface LimiterOptions {
  maxFailures: number;
  windowSeconds: number;
  /** Upper bound on tracked keys, so an attacker cycling keys cannot grow memory without limit. */
  maxKeys?: number;
}

interface Entry {
  failures: number;
  /** When this window ends (ms since epoch). */
  resetAt: number;
}

export class FailureLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly maxKeys: number;

  constructor(
    private readonly options: LimiterOptions,
    private readonly now: () => number = Date.now
  ) {
    this.maxKeys = options.maxKeys ?? 50_000;
  }

  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry && entry.resetAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Seconds until the key may try again, or 0 if it is not blocked. */
  retryAfter(key: string): number {
    const entry = this.live(key);
    if (!entry || entry.failures < this.options.maxFailures) return 0;
    return Math.max(1, Math.ceil((entry.resetAt - this.now()) / 1000));
  }

  recordFailure(key: string): void {
    const entry = this.live(key);
    if (entry) {
      entry.failures++;
      return;
    }
    if (this.entries.size >= this.maxKeys) this.prune();
    this.entries.set(key, { failures: 1, resetAt: this.now() + this.options.windowSeconds * 1000 });
  }

  /**
   * Same counter, for limits that count every ATTEMPT rather than failures
   * (e.g. account registrations per IP).
   */
  recordAttempt(key: string): void {
    this.recordFailure(key);
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  /** Drops expired windows; if still full, drops the oldest entries (Map keeps insertion order). */
  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.resetAt <= now) this.entries.delete(key);
    for (const key of this.entries.keys()) {
      if (this.entries.size < this.maxKeys) break;
      this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
