import type { IngestionOutcome } from "../schema.js";

/**
 * Every source -- however "friendly" or "hostile" -- implements this same
 * interface. That's the point: swapping RemoteOK for a headless-browser
 * scraper against a harder target later should mean writing one new file,
 * not touching the pipeline, scheduler, or storage layer.
 */
export interface JobSource {
  id: string;
  displayName: string;
  /** Fetch + parse one page of listings and return them already normalized. */
  fetchOnce(): Promise<IngestionOutcome>;
}
