export class JitteredScheduler {
    pipeline;
    opts;
    timer = null;
    running = false;
    constructor(pipeline, opts) {
        this.pipeline = pipeline;
        this.opts = opts;
    }
    scheduleNext() {
        const jitter = (Math.random() * 2 - 1) * this.opts.jitterMs; // +/- jitter
        const delay = Math.max(1000, this.opts.intervalMs + jitter);
        this.timer = setTimeout(() => this.tick(), delay);
    }
    async tick() {
        if (this.running) {
            this.scheduleNext();
            return;
        }
        this.running = true;
        try {
            const result = await this.pipeline.runOnce();
            this.opts.onTick?.(result);
        }
        finally {
            this.running = false;
            this.scheduleNext();
        }
    }
    start() {
        this.tick(); // run immediately on boot, then continue on jittered interval
    }
    stop() {
        if (this.timer)
            clearTimeout(this.timer);
    }
}
//# sourceMappingURL=scheduler.js.map