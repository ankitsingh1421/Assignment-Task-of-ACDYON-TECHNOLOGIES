import { z } from "zod";
import type { JobSource } from "./source.js";
import type { IngestionOutcome, NormalizedJob } from "../schema.js";
import { NormalizedJobSchema } from "../schema.js";
import { withRetry, RetryExhaustedError } from "../resilience/retry.js";

/**
 * RemoteOK publishes a genuinely public, unauthenticated JSON endpoint
 * (https://remoteok.com/api) and documents that they're fine with it being
 * consumed programmatically as long as callers identify themselves with a
 * descriptive User-Agent and don't hammer it. That's exactly the "public
 * job-board API" the assignment's scope guardrail asks for, and it's why
 * this adapter authenticates honestly instead of trying to blend in --
 * there's nothing to evade here, and pretending otherwise would just be
 * security theater. The stealth/evasion techniques discussed in DESIGN.md
 * are reserved for sources that actually require them; this endpoint
 * doesn't, and using them here would be lying to a host that already said
 * "yes, scrape this."
 */
const RAW_ENDPOINT = "https://remoteok.com/api";

const RemoteOkRawJobSchema = z.object({
  id: z.union([z.string(), z.number()]),
  slug: z.string().optional(),
  company: z.string(),
  position: z.string(),
  tags: z.array(z.string()).optional(),
  date: z.string().optional(),
  url: z.string(),
  location: z.string().optional(),
  salary_min: z.number().optional(),
  salary_max: z.number().optional(),
});

// RemoteOK's first array element is a legal/attribution notice, not a job --
// this is a real, documented quirk of the API and a small example of the
// kind of "the shape isn't quite what you assumed" problem this pipeline
// has to shrug off rather than crash on.
const RemoteOkResponseSchema = z.array(z.unknown());

function toNormalizedJob(raw: z.infer<typeof RemoteOkRawJobSchema>): NormalizedJob {
  const salary =
    raw.salary_min && raw.salary_max
      ? `$${raw.salary_min.toLocaleString()} - $${raw.salary_max.toLocaleString()}`
      : undefined;

  return NormalizedJobSchema.parse({
    sourceId: "remoteok",
    externalId: String(raw.id),
    title: raw.position,
    company: raw.company,
    location: raw.location && raw.location.length > 0 ? raw.location : "Remote",
    url: raw.url.startsWith("http") ? raw.url : `https://remoteok.com${raw.url}`,
    postedAt: raw.date ? new Date(raw.date).toISOString() : undefined,
    tags: raw.tags ?? [],
    salaryRaw: salary,
    fetchedAt: new Date().toISOString(),
  });
}

export function createRemoteOkSource(fetchImpl: typeof fetch = fetch): JobSource {
  return {
    id: "remoteok",
    displayName: "RemoteOK (public API)",

    async fetchOnce(): Promise<IngestionOutcome> {
      try {
        const res = await withRetry(
          async () => {
            const response = await fetchImpl(RAW_ENDPOINT, {
              headers: {
                // Honest identification, per RemoteOK's own API guidance.
                "User-Agent":
                  "AcdyonJobIngestion/1.0 (+https://github.com/ankitsingh1421/Assignment-Task-of-ACDYON-TECHNOLOGIES)",
                Accept: "application/json",
              },
            });
            if (response.status === 429 || response.status >= 500) {
              // Treat as retryable -- transient rate-limit or server hiccup.
              throw new Error(`retryable_status_${response.status}`);
            }
            if (!response.ok) {
              // Non-retryable (403/404/etc): don't burn retry budget on it.
              const err = new Error(`non_retryable_status_${response.status}`);
              (err as any).nonRetryable = true;
              throw err;
            }
            return response;
          },
          {
            maxAttempts: 3,
            baseDelayMs: 500,
            maxDelayMs: 5_000,
            shouldRetry: (err) => !(err as any)?.nonRetryable,
          }
        );

        const json = await res.json();
        const parsed = RemoteOkResponseSchema.safeParse(json);
        if (!parsed.success) {
          return { status: "schema_drift", sample: json, error: parsed.error.message };
        }

        // Drop the legal-notice element and anything that doesn't look like a job.
        const candidates = parsed.data.filter(
          (item): item is Record<string, unknown> =>
            typeof item === "object" && item !== null && "position" in item
        );

        if (candidates.length === 0) {
          return { status: "empty" };
        }

        const jobs: NormalizedJob[] = [];
        let driftSample: unknown = null;
        let driftError = "";
        for (const candidate of candidates) {
          const rawParsed = RemoteOkRawJobSchema.safeParse(candidate);
          if (!rawParsed.success) {
            // One bad record shouldn't kill the whole batch -- record the
            // drift and keep going, but surface it so it's not silent.
            driftSample = candidate;
            driftError = rawParsed.error.message;
            continue;
          }
          jobs.push(toNormalizedJob(rawParsed.data));
        }

        if (jobs.length === 0 && driftSample) {
          return { status: "schema_drift", sample: driftSample, error: driftError };
        }

        return {
          status: "ok",
          jobs,
          warning: driftSample ? `Skipped malformed record: ${driftError}` : undefined,
        };
      } catch (err) {
        if (err instanceof RetryExhaustedError) {
          const msg = String(err.lastError);
          if (msg.includes("status_403") || msg.includes("status_429")) {
            return { status: "blocked" };
          }
          return { status: "network_error", error: msg };
        }
        return { status: "network_error", error: String(err) };
      }
    },
  };
}
