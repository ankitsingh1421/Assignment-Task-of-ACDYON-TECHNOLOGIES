import { describe, it, expect, vi } from "vitest";
import { withRetry, RetryExhaustedError } from "../src/resilience/retry.js";
import { CircuitBreaker } from "../src/resilience/circuitBreaker.js";

describe("withRetry", () => {
  it("succeeds without retrying when the first attempt works", async () => {
    const fn = vi.fn(async () => "ok");
    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries up to maxAttempts then throws RetryExhaustedError", async () => {
    const fn = vi.fn(async () => {
      throw new Error("always fails");
    });
    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 })).rejects.toBeInstanceOf(
      RetryExhaustedError
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("stops early when shouldRetry returns false", async () => {
    const fn = vi.fn(async () => {
      throw new Error("non-retryable");
    });
    await expect(
      withRetry(fn, { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 5, shouldRetry: () => false })
    ).rejects.toBeInstanceOf(RetryExhaustedError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("CircuitBreaker", () => {
  it("stays closed until the failure threshold is hit", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    cb.onFailure();
    cb.onFailure();
    expect(cb.getState()).toBe("closed");
    expect(cb.canAttempt()).toBe(true);
  });

  it("opens after the threshold and blocks attempts during cooldown", () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 100_000 });
    cb.onFailure();
    cb.onFailure();
    expect(cb.getState()).toBe("open");
    expect(cb.canAttempt()).toBe(false);
  });

  it("resets to closed on success", () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 });
    cb.onFailure();
    cb.onSuccess();
    cb.onFailure();
    expect(cb.getState()).toBe("closed"); // one failure after reset shouldn't reopen it
  });
});
