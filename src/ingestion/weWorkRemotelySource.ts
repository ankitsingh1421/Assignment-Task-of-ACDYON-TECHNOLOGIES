import { XMLParser } from "fast-xml-parser";
import type { JobSource } from "./source.js";
import type { IngestionOutcome, NormalizedJob } from "../schema.js";
import { NormalizedJobSchema } from "../schema.js";
import { withRetry, RetryExhaustedError } from "../resilience/retry.js";

/**
 * Fallback source. This is the concrete answer to "what's your plan B when
 * the primary approach gets shut down": a second, independently-published,
 * ToS-sanctioned feed (WeWorkRemotely's public RSS) with its own parser, so
 * that a RemoteOK outage or format change degrades the pipeline instead of
 * halting it. The orchestrator (pipeline.ts) decides when to fail over.
 */
const RSS_ENDPOINT = "https://weworkremotely.com/remote-jobs.rss";

const parser = new XMLParser({ ignoreAttributes: false });

function extractCompanyAndTitle(rawTitle: string): { company: string; title: string } {
  // WWR titles are conventionally "Company: Job Title".
  const idx = rawTitle.indexOf(":");
  if (idx === -1) return { company: "Unknown", title: rawTitle.trim() };
  return {
    company: rawTitle.slice(0, idx).trim(),
    title: rawTitle.slice(idx + 1).trim(),
  };
}

export function createWeWorkRemotelySource(fetchImpl: typeof fetch = fetch): JobSource {
  return {
    id: "weworkremotely",
    displayName: "We Work Remotely (public RSS)",

    async fetchOnce(): Promise<IngestionOutcome> {
      try {
        const res = await withRetry(
          async () => {
            const response = await fetchImpl(RSS_ENDPOINT, {
              headers: {
                "User-Agent":
                  "AcdyonJobIngestion/1.0 (+https://github.com/ankitsingh1421/Assignment-Task-of-ACDYON-TECHNOLOGIES)",
                Accept: "application/rss+xml, application/xml, text/xml",
              },
            });
            if (response.status === 429 || response.status >= 500) {
              throw new Error(`retryable_status_${response.status}`);
            }
            if (!response.ok) {
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

        const xmlText = await res.text();
        let doc: any;
        try {
          doc = parser.parse(xmlText);
        } catch (parseErr) {
          return { status: "schema_drift", sample: xmlText.slice(0, 500), error: String(parseErr) };
        }

        const items = doc?.rss?.channel?.item;
        if (!items) {
          return { status: "schema_drift", sample: doc, error: "missing rss.channel.item" };
        }
        const itemList = Array.isArray(items) ? items : [items];
        if (itemList.length === 0) return { status: "empty" };

        const jobs: NormalizedJob[] = [];
        let invalidItems = 0;
        let driftError = "";
        for (const item of itemList) {
          if (!item?.title || !item?.link) {
            invalidItems++;
            driftError = "RSS item is missing title or link";
            continue;
          }
          const { company, title } = extractCompanyAndTitle(String(item.title));
          const job = NormalizedJobSchema.safeParse({
            sourceId: "weworkremotely",
            externalId: String(item.guid?.["#text"] ?? item.guid ?? item.link),
            title,
            company,
            location: "Remote",
            url: String(item.link),
            postedAt: item.pubDate ? new Date(item.pubDate).toISOString() : undefined,
            tags: item.category
              ? (Array.isArray(item.category) ? item.category : [item.category]).map(String)
              : [],
            fetchedAt: new Date().toISOString(),
          });
          if (job.success) jobs.push(job.data);
          else {
            invalidItems++;
            driftError = job.error.message;
          }
        }

        if (jobs.length === 0 && invalidItems > 0) {
          return { status: "schema_drift", sample: itemList[0], error: driftError };
        }
        return jobs.length > 0
          ? { status: "ok", jobs, warning: invalidItems ? `Skipped ${invalidItems} malformed RSS item(s): ${driftError}` : undefined }
          : { status: "empty" };
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
