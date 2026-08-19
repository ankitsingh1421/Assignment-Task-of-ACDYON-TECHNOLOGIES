import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
export function createJsonFileStore(filePath) {
    let cache = null;
    async function load() {
        if (cache)
            return cache;
        try {
            const raw = await readFile(filePath, "utf-8");
            const arr = JSON.parse(raw);
            cache = new Map(arr.map((j) => [`${j.sourceId}:${j.externalId}`, j]));
        }
        catch {
            cache = new Map();
        }
        return cache;
    }
    async function persist(map) {
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
                if (map.has(key))
                    updated++;
                else
                    inserted++;
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
export function createInMemoryStore() {
    const map = new Map();
    return {
        async upsertMany(jobs) {
            let inserted = 0;
            let updated = 0;
            for (const job of jobs) {
                const key = `${job.sourceId}:${job.externalId}`;
                if (map.has(key))
                    updated++;
                else
                    inserted++;
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
//# sourceMappingURL=store.js.map