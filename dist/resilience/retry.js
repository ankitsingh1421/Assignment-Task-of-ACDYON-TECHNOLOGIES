export class RetryExhaustedError extends Error {
    lastError;
    attempts;
    constructor(lastError, attempts) {
        super(`Retry exhausted after ${attempts} attempts: ${String(lastError)}`);
        this.lastError = lastError;
        this.attempts = attempts;
        this.name = "RetryExhaustedError";
    }
}
function fullJitterDelay(attempt, baseDelayMs, maxDelayMs) {
    const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
    return Math.random() * cap;
}
export async function withRetry(fn, opts) {
    let lastError;
    for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
            lastError = err;
            const keepGoing = opts.shouldRetry ? opts.shouldRetry(err, attempt) : true;
            if (!keepGoing || attempt === opts.maxAttempts - 1)
                break;
            const delay = fullJitterDelay(attempt, opts.baseDelayMs, opts.maxDelayMs);
            await new Promise((res) => setTimeout(res, delay));
        }
    }
    throw new RetryExhaustedError(lastError, opts.maxAttempts);
}
//# sourceMappingURL=retry.js.map