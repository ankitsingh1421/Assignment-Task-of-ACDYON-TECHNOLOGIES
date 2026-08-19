import { CircuitBreaker } from "./circuitBreaker.js";
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
    sources;
    store;
    breakers = new Map();
    health = new Map();
    constructor(sources, // priority order: primary first
    store, breakerOpts = { failureThreshold: 3, cooldownMs: 10 * 60 * 1000 }) {
        this.sources = sources;
        this.store = store;
        for (const s of sources) {
            this.breakers.set(s.id, new CircuitBreaker(breakerOpts));
            this.health.set(s.id, { sourceId: s.id, circuitState: "closed", consecutiveEmptyRuns: 0 });
        }
    }
    getHealth() {
        return [...this.health.values()];
    }
    /** Runs one tick: try sources in order until one yields usable jobs. */
    async runOnce() {
        const log = [];
        for (const source of this.sources) {
            const breaker = this.breakers.get(source.id);
            const health = this.health.get(source.id);
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
            const entry = {
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
                    entry.detail = outcome.error;
                    health.lastRun = entry;
                    log.push(entry);
                    continue;
                }
                case "network_error":
                case "blocked": {
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
//# sourceMappingURL=pipeline.js.map