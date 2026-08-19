# DESIGN.md — Getting Job Data Out Reliably

This covers the four things asked for: detection surface, ingestion strategy, resilience, and
where the line is. The **deployed demo** runs against two real, ToS-sanctioned public sources
(RemoteOK's public JSON API and We Work Remotely's public RSS feed) per the assignment's scope
guardrail. Sections 1–2 below describe the general problem space — including what a harder
target like LinkedIn or Indeed would require — because that's what the brief asks for, but the
stealth/evasion techniques described there are **not implemented** against any real target in
this submission. Section 4 explains why.

## 1. Detection surface

A platform trying to tell a bot from a person is really running several independent classifiers,
and any one of them failing is enough to get flagged:

- **TLS/HTTP fingerprint** — the order and casing of headers, the TLS ClientHello (cipher suites,
  extensions, JA3 hash), and HTTP/2 frame ordering are all different between `curl`/`requests`,
  headless Chrome, and real Chrome. Libraries that don't deliberately mimic a real browser's
  stack are fingerprinted before a single page loads.
- **Headless browser tells** — `navigator.webdriver === true`, missing or inconsistent
  `navigator.plugins`/`navigator.languages`, unusual `window.chrome` object shape, canvas/WebGL
  rendering that's suspiciously deterministic, and permissions-API responses that don't match a
  real profile.
- **Request timing and cadence** — inhumanly consistent intervals between requests, page-load-to-
  first-action latency that's too fast (a person takes 1-3s to read before clicking), and no
  variance across a session.
- **Behavioral patterns** — no mouse movement or scroll before a click, no idle time, identical
  session-to-session navigation paths, and requesting resources (pagination, detail pages) in a
  perfectly linear order a person wouldn't follow.
- **Volume/identity signals** — one IP or account making requests far outside normal human usage
  patterns, sudden bursts, or geographic mismatches between account and IP.

The design below is built to account for all five categories conceptually (that's the point of
this section), but the actual implementation only exercises the categories that matter for the
sanctioned sources in scope — see Section 4.

## 2. Ingestion strategy

**Architecture principle: sources are interchangeable.** Every source implements the same
`JobSource` interface (`fetchOnce(): Promise<IngestionOutcome>`), so nothing about the pipeline,
scheduler, storage, or API layer cares whether a given source is a friendly JSON API or a
headless-browser session against a hostile target. That's what makes the "plan B" question
answerable architecturally rather than as an afterthought: **sources are tried in priority
order, and the pipeline fails over automatically** if the primary is unavailable (see
`pipeline.ts`).

For the two in-scope sources, the strategy is simple and honest: identify with a descriptive
`User-Agent` (RemoteOK explicitly documents this as the expected behavior for programmatic
consumers), poll on a jittered interval so the cadence doesn't look like a fixed cron job, and
respect standard HTTP semantics (back off hard on 429/5xx, treat 403 as "stop, don't retry into
a wall").

**For a harder target** (what Part 1's brief is really probing), the same architecture would
need a source implementation that additionally handles:

- **Identity rotation** — a pool of residential/mobile proxies (datacenter IP ranges are
  block-listed almost immediately by these platforms) with sticky sessions per identity, so a
  single logical "user" doesn't jump IPs mid-session, which is itself a signal.
- **Pacing** — randomized inter-request delay drawn from a distribution that resembles human
  reading/browsing time, not a fixed sleep. Session-level rate caps (e.g., "no more than N
  profile views per identity per hour") tuned below the platform's known threshold, discovered
  empirically and conservatively.
- **Browser realism** — a real (non-headless) browser engine or one hardened against headless
  detection, with a fingerprint pool (viewport, timezone, font list, WebGL vendor string) that
  stays internally consistent per identity, and injected human-like interaction (scroll, mouse
  movement, variable dwell time) before extraction.
- **Session/account management** — if the target requires auth, isolate credentials per identity,
  warm new accounts gradually (real usage pattern before scraping starts), and retire identities
  that show any block signal rather than pushing them until they're fully banned.
- **Plan B** — exactly the fallback-source pattern already built: a secondary, lower-risk source
  (public listing aggregator, cached/syndicated feed, a partner data feed if one exists) that the
  pipeline switches to automatically when the primary's circuit breaker trips, so a block event
  degrades data freshness/coverage instead of taking the whole pipeline down.

None of the bullet points above are implemented in this submission's code — they're the honest
answer to "how would this generalize," not a working toolkit. See Section 4.

## 3. Resilience

Three failure modes are handled explicitly, each differently, because collapsing them into one
generic "retry and hope" produces a pipeline that either retries things it shouldn't or gives up
on things that would've worked:

| Failure | Detection | Response |
|---|---|---|
| Transient network blip / 429 / 5xx | HTTP status or fetch error | `retry.ts`: exponential backoff **with full jitter** (not fixed intervals — a fixed retry schedule is itself a timing fingerprint), max 3 attempts, then surfaced up |
| Source actively blocking us (403, repeated failures) | Non-retryable status or retries exhausted | `circuitBreaker.ts`: per-source breaker opens after N consecutive failures, forces a cooldown before the next attempt, and the pipeline **fails over to the next source in priority order** instead of hammering a source that's clearly blocking us |
| Markup/schema drift (source changed shape, or a field went missing) | Zod schema validation on every parsed record | Reported as `schema_drift`, **not** treated as a breaker failure (the source isn't blocking us, our parser is stale) — logged with a data sample for debugging, pipeline moves to the next source for that tick so data keeps flowing while a human fixes the parser |
| Response succeeds but returns zero listings | Parsed successfully, array length 0 | Reported as `empty`, tracked as a **consecutive-empty-run streak** per source — one empty run is unremarkable, but a growing streak is a strong "this is silently broken" signal an operator should see on `/health` before they'd otherwise notice |

The `/health` endpoint exists specifically so "silently failing" isn't possible — it reports each
source's circuit state, last run outcome, and consecutive-empty-run count, which is the
observability layer that turns "the pipeline looks fine but hasn't gotten new data in three days"
from an invisible problem into a visible one.

Deduplication happens at the storage layer via a composite `(sourceId, externalId)` key, so
re-running the same source repeatedly (or failing over and back) never produces duplicate
listings.

## 4. Where I'd stop

The honest line, in order:

1. **I won't run automated sessions against a real account on a platform whose ToS prohibits
   scraping**, even for a take-home demo. That's what the assignment's own scope guardrail asks
   for, and it's also just where I'd stop on a real engagement without an explicit commercial
   agreement (an official partner API, a data-licensing deal, or written permission) with the
   platform. "Technically possible" and "a good idea to actually run" are different questions,
   and burning an account or an IP range to prove a demo works isn't worth it even setting ToS
   aside.
2. **The deployed demo only touches sources that are public, unauthenticated, and either
   explicitly documented as programmatically-consumable (RemoteOK) or published specifically for
   syndication (RSS is *designed* to be machine-read).** No login, no paywall, no captcha, no
   identity rotation needed or used — there's nothing to evade because these hosts already said
   yes.
3. **Section 2's harder-target techniques are described, not built**, for the same reason: a
   working identity-rotation-plus-fingerprint-spoofing toolkit is dual-use in a way a design
   document isn't — it's useful for exactly the demo this assignment explicitly asks candidates
   *not* to run. Writing the architecture that would house it (interchangeable `JobSource`
   adapters, circuit breakers, failover) is a legitimate engineering answer; shipping a ready-to-
   point-at-LinkedIn scraper is a different thing, and it's not something I'd want to hand over
   even as a take-home artifact.
4. **If I were doing this for real** and a genuinely hard target were unavoidable, the next step
   before writing any evasion code would be checking whether an official API, data partnership,
   or licensed aggregator (many exist for exactly this job-data use case) makes the whole problem
   go away — that's usually both cheaper and more durable than an adversarial scraping arms race
   that a platform can win by changing one header check.
