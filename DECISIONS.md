# DECISIONS.md

## 1. Why this ingestion strategy over the obvious alternative I rejected?

The obvious alternative was to just build the headless-browser-plus-proxy-rotation scraper the
assignment describes and point it at a real target from day one, since that's the "impressive"
version. I rejected it for two reasons. First, the assignment's own scope guardrail asks for a
low-risk source — building the hostile-target version would mean either ignoring that guardrail
or building something I'd then have to *not run*, which is a worse demo than something that
actually works end-to-end. Second, and more importantly for the actual engineering problem: the
interesting design question isn't "can I spoof a fingerprint," it's "does the pipeline survive a
source going away," and that's fully demonstrable with two honest sources (RemoteOK's public API,
WeWorkRemotely's RSS) and a circuit-breaker/failover architecture that doesn't care *why* a source
is unavailable — blocked, down, rate-limited, and "I chose not to use it" all look the same to the
pipeline. I'd rather ship that correctly than ship a fragile evasion demo against a target that
could block the whole submission with one Cloudflare rule change before the grader even sees it.

## 2. One trade-off under the time limit, and what I'd do with a real week

**Trade-off:** storage is a JSON file with an in-process cache, not a real database. It's
correct (dedup key, atomic-enough writes for single-process use) but wouldn't survive concurrent
writers or scale past a few thousand listings without a rewrite. I chose it because pulling in
Postgres/SQLite-with-native-bindings adds deploy-environment risk (native module builds failing
on a free host) for zero demo value at this data volume.

**With a real week:** swap storage for Postgres with a unique constraint on
`(source_id, external_id)` (the `JobStore` interface is already written so this is a drop-in
swap, not a rewrite); add a real job queue (BullMQ/SQS) so ingestion ticks are retryable units of
work instead of an in-process scheduler that dies with the process; add structured metrics
(Prometheus/OpenTelemetry) instead of a JSON `/health` snapshot; and actually build one hardened
adapter for a harder public-but-uncooperative source (rate-limited but not ToS-hostile) to prove
the `JobSource` abstraction holds up against something less cooperative than RSS.

## 3. Where I used AI tools, and what I verified/changed afterward

I used Claude to scaffold this project end-to-end — the adapter interface, retry/circuit-breaker
utilities, pipeline orchestration, and test suite. What I verified personally: I ran the full test
suite (20 tests covering retry/backoff, breaker open/close/cooldown transitions, primary→fallback
failover, schema-drift vs. block-vs-empty classification, and dedup) and read every test to confirm
it actually exercises the behavior it claims to, not just that it passes. I also ran the built
server locally and confirmed `/health` correctly reports a blocked/degraded state rather than
crashing or silently reporting success — that observability behavior is the crux of the
"resilience" grading axis, so I didn't want to take it on faith. I changed the RemoteOK adapter's
error classification (originally treating all non-2xx as retryable) after noticing the first draft
would burn retry budget on a 404, which isn't a transient failure and shouldn't be treated like
one. I can walk through every file line-by-line in the follow-up call.
