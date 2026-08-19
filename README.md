# Acdyon Frontend Challenge — Part 1: Job Ingestion Pipeline

A resilient job-listing ingestion pipeline that pulls from two real, public, ToS-sanctioned
sources (RemoteOK's public JSON API and We Work Remotely's public RSS feed), with automatic
failover, per-source circuit breaking, schema-drift detection, and jittered polling.

See **[DESIGN.md](./DESIGN.md)** for the design writeup (detection surface, ingestion strategy,
resilience, and where the ethical/technical line is) and **[DECISIONS.md](./DECISIONS.md)** for
the required 1-page decisions summary.

## Architecture at a glance

```
src/
  schema.ts                    # canonical NormalizedJob shape + IngestionOutcome union
  ingestion/
    source.ts                  # JobSource interface every adapter implements
    remoteOkSource.ts          # primary source
    weWorkRemotelySource.ts    # fallback source
    scheduler.ts                # jittered polling loop
  resilience/
    retry.ts                   # exponential backoff with full jitter
    circuitBreaker.ts          # per-source breaker (closed/open/half_open)
    pipeline.ts                 # orchestrator: priority order, failover, health tracking
  storage/
    store.ts                   # JSON-file store with (sourceId, externalId) dedup
  server.ts                    # Express app: demo UI, /jobs, /health, /ingest
public/
  index.html                   # simple Part 1 operator demo
  styles.css
  app.js
tests/                          # 24 tests, all mocked (no live network needed to verify behavior)
```

## Running locally

```bash
npm install
npm run build
npm start
# or for dev with auto-reload:
npm run dev
```

Open http://localhost:3000 to view the simple ingestion demo. The **Fetch jobs now** button
triggers one immediate pipeline run; the background scheduler continues to poll automatically.

Endpoints:
- `GET /jobs` — all stored listings (`?source=remoteok`, `?limit=10` supported)
- `GET /health` — per-source circuit state, last run outcome, consecutive-empty-run streaks
- `POST /ingest` — trigger one immediate ingestion pass (used by the demo button)
- `GET /` — the demo dashboard

## Running tests

```bash
npm test
```

24 tests across 4 files, all using mocked `fetch` (no live network dependency, so they're
deterministic in CI and reviewable without hitting real endpoints):
- `tests/remoteOkSource.test.ts` — parsing, schema drift, blocked/retry classification
- `tests/weWorkRemotelySource.test.ts` — RSS parsing, drift, blocked classification
- `tests/resilience.test.ts` — retry/backoff behavior, circuit breaker state transitions
- `tests/pipeline.test.ts` — **the important one**: proves primary→fallback failover, breaker
  tripping + skip-on-open, schema-drift *not* tripping the breaker, and dedup across ticks
