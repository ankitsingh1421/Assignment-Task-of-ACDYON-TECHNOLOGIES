export class CircuitBreaker {
    opts;
    state = "closed";
    consecutiveFailures = 0;
    openedAt = 0;
    constructor(opts) {
        this.opts = opts;
    }
    canAttempt() {
        if (this.state !== "open")
            return true;
        const elapsed = Date.now() - this.openedAt;
        if (elapsed >= this.opts.cooldownMs) {
            this.state = "half_open"; // allow exactly one probe request through
            return true;
        }
        return false;
    }
    onSuccess() {
        this.consecutiveFailures = 0;
        this.state = "closed";
    }
    onFailure() {
        this.consecutiveFailures += 1;
        if (this.state === "half_open" || this.consecutiveFailures >= this.opts.failureThreshold) {
            this.state = "open";
            this.openedAt = Date.now();
        }
    }
    getState() {
        return this.state;
    }
    msUntilRetry() {
        if (this.state !== "open")
            return 0;
        return Math.max(0, this.opts.cooldownMs - (Date.now() - this.openedAt));
    }
}
//# sourceMappingURL=circuitBreaker.js.map