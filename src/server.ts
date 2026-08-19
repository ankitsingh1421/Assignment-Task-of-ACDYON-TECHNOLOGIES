import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRemoteOkSource } from "./ingestion/remoteOkSource.js";
import { createWeWorkRemotelySource } from "./ingestion/weWorkRemotelySource.js";
import { IngestionPipeline } from "./resilience/pipeline.js";
import { JitteredScheduler } from "./ingestion/scheduler.js";
import { createJsonFileStore } from "./storage/store.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const DATA_FILE = process.env.DATA_FILE ?? "./data/jobs.json";
const POLL_INTERVAL_MS = process.env.POLL_INTERVAL_MS ? Number(process.env.POLL_INTERVAL_MS) : 5 * 60 * 1000;

const store = createJsonFileStore(DATA_FILE);

// Priority order = primary first, fallback second. See pipeline.ts for the
// failover logic and DESIGN.md section 2 for why these two sources specifically.
const pipeline = new IngestionPipeline([createRemoteOkSource(), createWeWorkRemotelySource()], store);

let lastRunLog: Awaited<ReturnType<IngestionPipeline["runOnce"]>>["log"] = [];
let lastUsedSource: string | null = null;

const scheduler = new JitteredScheduler(pipeline, {
  intervalMs: POLL_INTERVAL_MS,
  jitterMs: POLL_INTERVAL_MS * 0.3, // +/-30% -- avoids a robotic fixed cadence
  onTick: (result) => {
    lastRunLog = result.log;
    lastUsedSource = result.usedSource;
    console.log(`[ingestion] tick complete. used=${result.usedSource ?? "none"}`, result.log);
  },
});

const app = express();
const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "../public");

app.use(express.static(publicDir));

app.get("/jobs", async (req, res) => {
  const source = typeof req.query.source === "string" ? req.query.source : undefined;
  const jobs = source ? await store.bySource(source) : await store.all();
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  res.json({ count: jobs.length, jobs: limit ? jobs.slice(0, limit) : jobs });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    lastUsedSource,
    lastRun: lastRunLog,
    sources: pipeline.getHealth(),
  });
});

app.post("/ingest", async (_req, res) => {
  try {
    const result = await pipeline.runOnce();
    lastRunLog = result.log;
    lastUsedSource = result.usedSource;
    res.json({ ok: result.usedSource !== null, ...result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Ingestion failed" });
  }
});

app.get("/", (_req, res) => {
  res.json({
    service: "acdyon-job-ingestion",
    endpoints: ["/jobs", "/jobs?source=remoteok", "/jobs?limit=10", "/health", "/ingest"],
  });
});

app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
  scheduler.start();
});
