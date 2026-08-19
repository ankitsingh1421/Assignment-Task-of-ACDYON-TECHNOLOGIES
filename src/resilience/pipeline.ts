import type { JobSource } from "../ingestion/source.js";
import type { JobStore } from "../storage/store.js";
import { CircuitBreaker } from "./circuitBreaker.js";

export interface SourceRunLog {
  sourceId: string;
  status: string;
  timestamp: string;
  jobsFound?: number;
  detail?: string;
}

export interface SourceHealth {
  sourceId: string;
  circuitState: "closed" | "open" | "half_open";
  consecutiveEmptyRuns: number;
  lastRun?: SourceRunLog;
  lastSuccessAt?: string;
}

/**
 * Runs a prioritized list of sources for one polling tick. Encodes three
 * resilience decisions that map directly to the assignment's brief:
 *
 * 1. "markup changes overnight / empty response comes back" -> schema_drift
 *    and repeated `empty` results are tracked per source and surfaced via
 *    getHealth(), rather than being swallowed as a quiet zero-row result.
 * 2. "rate-limits you mid-run" -> each source has its own circuit breaker;
 *    a blocked/network-error result trips it, and the breaker is what
 *    decides whether we even attempt that source on the next tick.
 * 3. "plan B" -> sources are tried in priority order; if the primary is
 *    open (circuit tripped) or returns empty/drift, the pipeline falls
 *    through to the next source instead of reporting total failure.
 */
export class IngestionPipeline {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly health = new Map<string, SourceHealth>();
  private activeRun: Promise<{ usedSource: string | null; log: SourceRunLog[] }> | null = null;

  constructor(
    private readonly sources: JobSource[], // priority order: primary first
    private readonly store: JobStore,
    breakerOpts = { failureThreshold: 3, cooldownMs: 10 * 60 * 1000 }
  ) {
    for (const s of sources) {
      this.breakers.set(s.id, new CircuitBreaker(breakerOpts));
      this.health.set(s.id, { sourceId: s.id, circuitState: "closed", consecutiveEmptyRuns: 0 });
    }
  }

  getHealth(): SourceHealth[] {
    return [...this.health.values()];
  }

  /** Runs one tick: try sources in order until one yields usable jobs. */
  async runOnce(): Promise<{ usedSource: string | null; log: SourceRunLog[] }> {
    if (this.activeRun) return this.activeRun;
    this.activeRun = this.runOnceInternal();
    try {
      return await this.activeRun;
    } finally {
      this.activeRun = null;
    }
  }

  private async runOnceInternal(): Promise<{ usedSource: string | null; log: SourceRunLog[] }> {
    const log: SourceRunLog[] = [];

    for (const source of this.sources) {
      const breaker = this.breakers.get(source.id)!;
      const health = this.health.get(source.id)!;

      if (!breaker.canAttempt()) {
        log.push({
          sourceId: source.id,
          status: "skipped_circuit_open",
          timestamp: new Date().toISOString(),
          detail: `retry in ${Math.ceil(breaker.msUntilRetry() / 1000)}s`,
        });
        continue; // don't even try -- fall through to next source
      }

      const outcome = await source.fetchOnce();
      const entry: SourceRunLog = {
        sourceId: source.id,
        status: outcome.status,
        timestamp: new Date().toISOString(),
      };

      switch (outcome.status) {
        case "ok": {
          breaker.onSuccess();
          health.consecutiveEmptyRuns = 0;
          health.lastSuccessAt = entry.timestamp;
          entry.jobsFound = outcome.jobs.length;
          entry.detail = outcome.warning;
          await this.store.upsertMany(outcome.jobs);
          health.circuitState = breaker.getState();
          health.lastRun = entry;
          log.push(entry);
          return { usedSource: source.id, log }; // success: stop here, don't hit other sources needlessly
        }
        case "empty": {
          // Reachable, not blocked, just nothing new -- not a failure, but
          // track streaks because a source that's "empty" for days running
          // is more likely silently broken than a real zero-listing day.
          breaker.onSuccess();
          health.consecutiveEmptyRuns += 1;
          health.circuitState = breaker.getState();
          health.lastRun = entry;
          log.push(entry);
          continue; // try next source too, since we got nothing usable
        }
        case "schema_drift": {
          // Explicitly NOT a breaker failure -- the source is responding
          // fine, our parser is what's stale. Flag loudly, don't punish
          // the source with a cooldown it doesn't deserve.
          health.consecutiveEmptyRuns = 0;
          entry.detail = outcome.error;
          health.lastRun = entry;
          log.push(entry);
          continue;
        }
        case "network_error":
        case "blocked": {
          health.consecutiveEmptyRuns = 0;
          breaker.onFailure();
          health.circuitState = breaker.getState();
          health.lastRun = entry;
          log.push(entry);
          continue; // fail over to next source
        }
      }
    }

    return { usedSource: null, log };
  }
}
