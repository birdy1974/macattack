/**
 * Small concurrency helpers: bounded parallel mapping and per-host rate limiting.
 *
 * Used by the scanner (bounded MAC checking), the quality check (parallel
 * channel probes) and the proxy validator. Deliberately dependency-free.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Map over items with at most `limit` promises in flight. Results keep the
 * input order. Rejections propagate only if `stopOnError` is true (default:
 * errors are captured and returned in place of a result, so one bad item
 * cannot abort a whole scan).
 */
export async function pMapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  options: { stopOnError?: boolean; shouldStop?: () => boolean } = {}
): Promise<Array<R | undefined>> {
  const concurrency = Math.max(1, Math.min(Math.floor(limit) || 1, 32));
  const results = new Array<R | undefined>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      if (options.shouldStop?.()) return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        if (options.stopOnError) throw error;
        results[index] = undefined;
      }
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * Per-host minimum interval limiter. Portal owners react badly to bursts, so
 * every request in a concurrent scan passes through this gate.
 */
export class HostRateLimiter {
  private readonly minIntervalMs: number;
  private readonly nextAllowedAt = new Map<string, number>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(minIntervalMs: number) {
    this.minIntervalMs = Math.max(0, minIntervalMs);
  }

  async wait(host: string): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const key = host.toLowerCase();
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.then(async () => {
      const now = Date.now();
      const allowedAt = this.nextAllowedAt.get(key) ?? 0;
      const delay = allowedAt - now;
      if (delay > 0) await sleep(delay);
      this.nextAllowedAt.set(key, Date.now() + this.minIntervalMs);
    });
    this.queues.set(
      key,
      current.catch(() => undefined)
    );
    await current;
  }
}

/** Extract a hostname (for rate limiting) from a URL or bare host:port string. */
export function hostOf(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    const withoutScheme = value.replace(/^[a-z]+:\/\//i, "");
    return withoutScheme.split(/[/:?]/)[0].toLowerCase() || "unknown";
  }
}
