import type { IngestionPipeline } from "../resilience/pipeline.js";

/**
 * Polls on a jittered interval rather than a fixed cron tick. A bot that
 * hits an endpoint at exactly :00 and :30 every minute is trivially
 * fingerprintable by request-timing analysis alone, even if every other
 * header looks human. Jitter here is cheap insurance and, more importantly,
 * matches how a real human-triggered background job would actually behave.
 */
export interface SchedulerOptions {
  intervalMs: number;
  jitterMs: number;
  onTick?: (result: Awaited<ReturnType<IngestionPipeline["runOnce"]>>) => void;
}

export class JitteredScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly pipeline: IngestionPipeline, private readonly opts: SchedulerOptions) {}

  private scheduleNext(): void {
    const jitter = (Math.random() * 2 - 1) * this.opts.jitterMs; // +/- jitter
    const delay = Math.max(1000, this.opts.intervalMs + jitter);
    this.timer = setTimeout(() => this.tick(), delay);
  }

  private async tick(): Promise<void> {
    if (this.running) {
      this.scheduleNext();
      return;
    }
    this.running = true;
    try {
      const result = await this.pipeline.runOnce();
      this.opts.onTick?.(result);
    } finally {
      this.running = false;
      this.scheduleNext();
    }
  }

  start(): void {
    this.tick(); // run immediately on boot, then continue on jittered interval
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
