import { describe, it, expect, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { createRemoteOkSource } from "../src/ingestion/remoteOkSource.js";

const fixturePath = new URL("./fixtures/remoteok-sample.json", import.meta.url);

function mockFetch(response: { status: number; body: unknown }) {
  return vi.fn(async () =>
    ({
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
      text: async () => JSON.stringify(response.body),
    }) as unknown as Response
  );
}

describe("RemoteOK source", () => {
  it("parses a healthy response into normalized jobs, skipping the legal-notice element", async () => {
    const body = JSON.parse(await readFile(fixturePath, "utf-8"));
    const source = createRemoteOkSource(mockFetch({ status: 200, body }));
    const outcome = await source.fetchOnce();

    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.jobs).toHaveLength(2);
      expect(outcome.jobs[0].title).toBe("Senior Frontend Engineer");
      expect(outcome.jobs[0].company).toBe("Acme Robotics");
      expect(outcome.jobs[0].salaryRaw).toBe("$120,000 - $160,000");
      // location fallback for empty string
      expect(outcome.jobs[1].location).toBe("Remote");
    }
  });

  it("reports schema_drift when the response shape is unrecognizable", async () => {
    const source = createRemoteOkSource(mockFetch({ status: 200, body: { totally: "different shape" } }));
    const outcome = await source.fetchOnce();
    expect(outcome.status).toBe("schema_drift");
  });

  it("reports empty when the response is an empty array", async () => {
    const source = createRemoteOkSource(mockFetch({ status: 200, body: [{ legal: "notice only" }] }));
    const outcome = await source.fetchOnce();
    expect(outcome.status).toBe("empty");
  });

  it("reports empty when the API returns no records at all", async () => {
    const source = createRemoteOkSource(mockFetch({ status: 200, body: [] }));
    const outcome = await source.fetchOnce();
    expect(outcome.status).toBe("empty");
  });

  it("reports blocked on a 403 after exhausting retries", async () => {
    const source = createRemoteOkSource(mockFetch({ status: 403, body: {} }));
    const outcome = await source.fetchOnce();
    expect(outcome.status).toBe("blocked");
  });

  it("retries on 429 and eventually succeeds", async () => {
    const body = JSON.parse(await readFile(fixturePath, "utf-8"));
    let calls = 0;
    const flaky = vi.fn(async () => {
      calls++;
      if (calls < 2) {
        return { ok: false, status: 429, json: async () => ({}), text: async () => "" } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
    });
    const source = createRemoteOkSource(flaky);
    const outcome = await source.fetchOnce();
    expect(outcome.status).toBe("ok");
    expect(calls).toBe(2);
  });
});
