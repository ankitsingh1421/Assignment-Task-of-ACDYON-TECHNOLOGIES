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
  server.ts                    # Express app: /jobs, /health
tests/                          # 20 tests, all mocked (no live network needed to verify behavior)
```

## Running locally

```bash
npm install
npm run build
npm start
# or for dev with auto-reload:
npm run dev
```

Endpoints:
- `GET /jobs` — all stored listings (`?source=remoteok`, `?limit=10` supported)
- `GET /health` — per-source circuit state, last run outcome, consecutive-empty-run streaks
- `GET /` — endpoint index

## Running tests

```bash
npm test
```

20 tests across 4 files, all using mocked `fetch` (no live network dependency, so they're
deterministic in CI and reviewable without hitting real endpoints):
- `tests/remoteOkSource.test.ts` — parsing, schema drift, blocked/retry classification
- `tests/weWorkRemotelySource.test.ts` — RSS parsing, drift, blocked classification
- `tests/resilience.test.ts` — retry/backoff behavior, circuit breaker state transitions
- `tests/pipeline.test.ts` — **the important one**: proves primary→fallback failover, breaker
  tripping + skip-on-open, schema-drift *not* tripping the breaker, and dedup across ticks

## Deploying (Render — free tier)

1. Push this repo to GitHub.
2. On [render.com](https://render.com): New → Web Service → connect the repo.
3. Render will detect `render.yaml` in this repo and pre-fill the config, or set manually:
   - Build command: `npm install && npm run build`
   - Start command: `npm start`
   - Environment: Node
4. Optional env vars (defaults shown):
   - `PORT` — set automatically by Render
   - `POLL_INTERVAL_MS=300000` — 5 minutes between ingestion ticks
   - `DATA_FILE=./data/jobs.json` — note: Render's free tier has an ephemeral filesystem, so data
     resets on redeploy/restart. For a persistent demo, mount a Render Disk or swap in Postgres
     per DECISIONS.md's "what I'd do with a real week" section.
5. Deploy. Hit `https://<your-service>.onrender.com/health` first — it should show both sources
   reachable within one poll interval. Then `/jobs` should show listings.

## Deploying (Railway — equally easy alternative)

```bash
railway login
railway init
railway up
```
Railway auto-detects the Node build; set `POLL_INTERVAL_MS` in the Railway dashboard if you want
a different cadence than the 5-minute default.

## A note on the two sources

- **RemoteOK** (`https://remoteok.com/api`) is documented by RemoteOK itself as fine to consume
  programmatically, provided callers send a descriptive `User-Agent` — which is exactly what
  `remoteOkSource.ts` does. No auth, no stealth needed.
- **We Work Remotely** publishes `https://weworkremotely.com/remote-jobs.rss` specifically for
  syndication — RSS is machine-readable by design.

Both are real, live, production sources — this isn't a mock demo. If one goes down or changes
shape, `/health` will show it and the pipeline fails over automatically.
