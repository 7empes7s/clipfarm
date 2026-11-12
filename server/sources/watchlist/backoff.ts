/** Wait after `failures` errors in a row: base, 2×, 4×… up to `maxMs`. */
export function backoffDelayMs(failures: number, baseMs: number, maxMs = 6 * 3600_000): number {
  if (failures <= 0) return 0;
  return Math.min(maxMs, baseMs * 2 ** (failures - 1));
}

/** Per-platform polling backoff: errors push the next try out, a success resets it. */
export class Backoff {
  failures = 0;
  until: Date | null = null;
  lastError: string | null = null;

  constructor(private baseMs: number) {}

  ready(now: Date): boolean {
    return this.until === null || now.getTime() >= this.until.getTime();
  }

  /** `retryAfterSec` (from a 429 answer) is honoured when it is longer than our own wait. */
  fail(now: Date, error: string, retryAfterSec?: number): void {
    this.failures++;
    this.lastError = error;
    const wait = Math.max(backoffDelayMs(this.failures, this.baseMs), (retryAfterSec ?? 0) * 1000);
    this.until = new Date(now.getTime() + wait);
  }

  succeed(): void {
    this.failures = 0;
    this.until = null;
    this.lastError = null;
  }
}
