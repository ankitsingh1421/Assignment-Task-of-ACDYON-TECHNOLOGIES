/**
 * Per-source circuit breaker. The failure mode we're guarding against isn't
 * "one request failed" (retry.ts handles that) -- it's "this source has
 * started blocking us and every request for the next hour will fail too."
 * Hammering a source that's actively blocking you is exactly the kind of
 * behavioral signature that gets an IP or account permanently burned instead
 * of temporarily rate-limited. The breaker forces a cooldown so the pipeline
 * backs off at the source level, not just the request level.
 */
type State = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  failureThreshold: number; // consecutive failures before opening
  cooldownMs: number; // how long to stay open before trying again
}

export class CircuitBreaker {
  private state: State = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(private readonly opts: CircuitBreakerOptions) {}

  canAttempt(): boolean {
    if (this.state !== "open") return true;
    const elapsed = Date.now() - this.openedAt;
    if (elapsed >= this.opts.cooldownMs) {
      this.state = "half_open"; // allow exactly one probe request through
      return true;
    }
    return false;
  }

  onSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "closed";
  }

  onFailure(): void {
    this.consecutiveFailures += 1;
    if (this.state === "half_open" || this.consecutiveFailures >= this.opts.failureThreshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }

  getState(): State {
    return this.state;
  }

  msUntilRetry(): number {
    if (this.state !== "open") return 0;
    return Math.max(0, this.opts.cooldownMs - (Date.now() - this.openedAt));
  }
}
