import { describe, it, expect } from "vitest";
import { IngestionPipeline } from "../src/resilience/pipeline.js";
import { createInMemoryStore } from "../src/storage/store.js";
import type { JobSource } from "../src/ingestion/source.js";
import type { IngestionOutcome, NormalizedJob } from "../src/schema.js";

function job(id: string, sourceId: string): NormalizedJob {
  return {
    sourceId,
    externalId: id,
    title: `Job ${id}`,
    company: "TestCo",
    location: "Remote",
    url: `https://example.com/${id}`,
    tags: [],
    fetchedAt: new Date().toISOString(),
  };
}

function fakeSource(id: string, outcomes: IngestionOutcome[]): JobSource {
  let call = 0;
  return {
    id,
    displayName: id,
    async fetchOnce() {
      const outcome = outcomes[Math.min(call, outcomes.length - 1)];
      call++;
      return outcome;
    },
  };
}

describe("IngestionPipeline", () => {
  it("uses the primary source when it succeeds", async () => {
    const primary = fakeSource("primary", [{ status: "ok", jobs: [job("1", "primary")] }]);
    const fallback = fakeSource("fallback", [{ status: "ok", jobs: [job("2", "fallback")] }]);
    const store = createInMemoryStore();
    const pipeline = new IngestionPipeline([primary, fallback], store);

    const result = await pipeline.runOnce();
    expect(result.usedSource).toBe("primary");
    expect(await store.all()).toHaveLength(1);
  });

  it("falls back to the secondary source when the primary is blocked", async () => {
    const primary = fakeSource("primary", [{ status: "blocked" }]);
    const fallback = fakeSource("fallback", [{ status: "ok", jobs: [job("2", "fallback")] }]);
    const store = createInMemoryStore();
    const pipeline = new IngestionPipeline([primary, fallback], store);

    const result = await pipeline.runOnce();
    expect(result.usedSource).toBe("fallback");
    const stored = await store.all();
    expect(stored).toHaveLength(1);
    expect(stored[0].sourceId).toBe("fallback");
  });

  it("trips the circuit breaker after repeated failures and skips the source on the next tick", async () => {
    const primary = fakeSource("primary", [
      { status: "blocked" },
      { status: "blocked" },
      { status: "blocked" },
    ]);
    const fallback = fakeSource("fallback", [{ status: "ok", jobs: [job("2", "fallback")] }]);
    const store = createInMemoryStore();
    // threshold of 2 for a fast test
    const pipeline = new IngestionPipeline([primary, fallback], store, {
      failureThreshold: 2,
      cooldownMs: 60_000,
    });

    await pipeline.runOnce(); // failure 1
    await pipeline.runOnce(); // failure 2 -> breaker opens
    const health = pipeline.getHealth().find((h) => h.sourceId === "primary")!;
    expect(health.circuitState).toBe("open");

    const result = await pipeline.runOnce();
    const primaryLog = result.log.find((l) => l.sourceId === "primary");
    expect(primaryLog?.status).toBe("skipped_circuit_open");
    expect(result.usedSource).toBe("fallback");
  });

  it("does not trip the breaker on schema_drift (it's a parser problem, not a blocking problem)", async () => {
    const primary = fakeSource("primary", [
      { status: "schema_drift", sample: {}, error: "boom" },
      { status: "schema_drift", sample: {}, error: "boom" },
      { status: "schema_drift", sample: {}, error: "boom" },
    ]);
    const fallback = fakeSource("fallback", [{ status: "empty" }]);
    const store = createInMemoryStore();
    const pipeline = new IngestionPipeline([primary, fallback], store, {
      failureThreshold: 2,
      cooldownMs: 60_000,
    });

    await pipeline.runOnce();
    await pipeline.runOnce();
    await pipeline.runOnce();
    const health = pipeline.getHealth().find((h) => h.sourceId === "primary")!;
    expect(health.circuitState).toBe("closed");
  });

  it("tracks consecutive empty runs per source", async () => {
    const primary = fakeSource("primary", [{ status: "empty" }]);
    const fallback = fakeSource("fallback", [{ status: "empty" }]);
    const store = createInMemoryStore();
    const pipeline = new IngestionPipeline([primary, fallback], store);

    await pipeline.runOnce();
    await pipeline.runOnce();
    const health = pipeline.getHealth().find((h) => h.sourceId === "primary")!;
    expect(health.consecutiveEmptyRuns).toBe(2);
  });

  it("de-dupes jobs across ticks via upsert", async () => {
    const primary = fakeSource("primary", [
      { status: "ok", jobs: [job("1", "primary")] },
      { status: "ok", jobs: [job("1", "primary"), job("2", "primary")] },
    ]);
    const store = createInMemoryStore();
    const pipeline = new IngestionPipeline([primary], store);

    await pipeline.runOnce();
    await pipeline.runOnce();
    expect(await store.all()).toHaveLength(2);
  });
});
