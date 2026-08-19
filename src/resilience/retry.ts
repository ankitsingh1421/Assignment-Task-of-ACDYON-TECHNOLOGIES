/**
 * Exponential backoff with full jitter (AWS-style: random(0, cap) rather than
 * a fixed multiplier). Full jitter matters here specifically because a fixed
 * backoff schedule is itself a fingerprint -- a source watching request
 * timing can spot "retries every 2s, 4s, 8s" as clearly as it can spot "no
 * retries at all". Randomizing the wait makes our retry behavior look less
 * like a script and reduces thundering-herd risk if we ever run multiple
 * workers against the same source.
 */
export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Called between attempts; return false to abort retrying early. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

export class RetryExhaustedError extends Error {
  constructor(public readonly lastError: unknown, public readonly attempts: number) {
    super(`Retry exhausted after ${attempts} attempts: ${String(lastError)}`);
    this.name = "RetryExhaustedError";
  }
}

function fullJitterDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.random() * cap;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const keepGoing = opts.shouldRetry ? opts.shouldRetry(err, attempt) : true;
      if (!keepGoing || attempt === opts.maxAttempts - 1) break;
      const delay = fullJitterDelay(attempt, opts.baseDelayMs, opts.maxDelayMs);
      await new Promise((res) => setTimeout(res, delay));
    }
  }
  throw new RetryExhaustedError(lastError, opts.maxAttempts);
}
