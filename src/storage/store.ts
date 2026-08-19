import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { NormalizedJob } from "../schema.js";

/**
 * Deliberately the simplest thing that works: a JSON file, de-duped by
 * `${sourceId}:${externalId}`. For the take-home this avoids pulling in a
 * database and native-module build issues on the deploy target. At real
 * scale this is a straight swap for Postgres with a unique constraint on
 * (source_id, external_id) -- the interface below is written so that swap
 * doesn't touch any calling code.
 */
export interface JobStore {
  upsertMany(jobs: NormalizedJob[]): Promise<{ inserted: number; updated: number }>;
  all(): Promise<NormalizedJob[]>;
  bySource(sourceId: string): Promise<NormalizedJob[]>;
}

export function createJsonFileStore(filePath: string): JobStore {
  let cache: Map<string, NormalizedJob> | null = null;

  async function load(): Promise<Map<string, NormalizedJob>> {
    if (cache) return cache;
    try {
      const raw = await readFile(filePath, "utf-8");
      const arr: NormalizedJob[] = JSON.parse(raw);
      cache = new Map(arr.map((j) => [`${j.sourceId}:${j.externalId}`, j]));
    } catch {
      cache = new Map();
    }
    return cache;
  }

  async function persist(map: Map<string, NormalizedJob>): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify([...map.values()], null, 2), "utf-8");
  }

  return {
    async upsertMany(jobs) {
      const map = await load();
      let inserted = 0;
      let updated = 0;
      for (const job of jobs) {
        const key = `${job.sourceId}:${job.externalId}`;
        if (map.has(key)) updated++;
        else inserted++;
        map.set(key, job);
      }
      await persist(map);
      return { inserted, updated };
    },
    async all() {
      const map = await load();
      return [...map.values()].sort((a, b) => (a.postedAt ?? "").localeCompare(b.postedAt ?? "")).reverse();
    },
    async bySource(sourceId) {
      const map = await load();
      return [...map.values()].filter((j) => j.sourceId === sourceId);
    },
  };
}

/** In-memory variant for tests. */
export function createInMemoryStore(): JobStore {
  const map = new Map<string, NormalizedJob>();
  return {
    async upsertMany(jobs) {
      let inserted = 0;
      let updated = 0;
      for (const job of jobs) {
        const key = `${job.sourceId}:${job.externalId}`;
        if (map.has(key)) updated++;
        else inserted++;
        map.set(key, job);
      }
      return { inserted, updated };
    },
    async all() {
      return [...map.values()];
    },
    async bySource(sourceId) {
      return [...map.values()].filter((j) => j.sourceId === sourceId);
    },
  };
}
