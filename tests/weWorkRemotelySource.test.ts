import { describe, it, expect, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { createWeWorkRemotelySource } from "../src/ingestion/weWorkRemotelySource.js";

const fixturePath = new URL("./fixtures/wwr-sample.rss", import.meta.url);

function mockFetch(status: number, text: string) {
  return vi.fn(async () =>
    ({ ok: status >= 200 && status < 300, status, text: async () => text }) as unknown as Response
  );
}

describe("WeWorkRemotely RSS source", () => {
  it("parses RSS items and splits 'Company: Title' correctly", async () => {
    const xml = await readFile(fixturePath, "utf-8");
    const source = createWeWorkRemotelySource(mockFetch(200, xml));
    const outcome = await source.fetchOnce();

    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.jobs).toHaveLength(2);
      expect(outcome.jobs[0].company).toBe("Globex Inc");
      expect(outcome.jobs[0].title).toBe("Product Designer");
      expect(outcome.jobs[1].company).toBe("Initech");
    }
  });

  it("reports schema_drift on unparseable XML", async () => {
    const source = createWeWorkRemotelySource(mockFetch(200, "<not-rss>oops"));
    const outcome = await source.fetchOnce();
    expect(outcome.status).toBe("schema_drift");
  });

  it("reports blocked on repeated 403", async () => {
    const source = createWeWorkRemotelySource(mockFetch(403, ""));
    const outcome = await source.fetchOnce();
    expect(outcome.status).toBe("blocked");
  });

  it("reports schema drift when every RSS item is malformed", async () => {
    const source = createWeWorkRemotelySource(mockFetch(200, "<rss><channel><item><title>Missing link</title></item></channel></rss>"));
    const outcome = await source.fetchOnce();
    expect(outcome.status).toBe("schema_drift");
  });
});
