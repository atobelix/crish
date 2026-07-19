import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker, Semaphore, TokenBucket } from "./backpressure";

describe("TokenBucket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows consuming within capacity", () => {
    const bucket = new TokenBucket(10, 10);
    expect(bucket.tryConsume(5)).toBe(true);
    expect(bucket.remaining).toBe(5);
  });

  it("rejects when insufficient tokens", () => {
    const bucket = new TokenBucket(5, 5);
    expect(bucket.tryConsume(6)).toBe(false);
    expect(bucket.remaining).toBe(5);
  });

  it("refills tokens over time", () => {
    const bucket = new TokenBucket(10, 5, 1000);
    expect(bucket.tryConsume(10)).toBe(true);
    expect(bucket.remaining).toBe(0);

    vi.advanceTimersByTime(2000);
    expect(bucket.remaining).toBe(10);
    expect(bucket.tryConsume(5)).toBe(true);
  });

  it("does not exceed capacity", () => {
    const bucket = new TokenBucket(10, 100, 1000);
    expect(bucket.tryConsume(5)).toBe(true);
    expect(bucket.remaining).toBe(5);

    vi.advanceTimersByTime(5000);
    expect(bucket.remaining).toBe(10);
  });

  it("handles partial refill intervals", () => {
    const bucket = new TokenBucket(10, 5, 1000);
    expect(bucket.tryConsume(10)).toBe(true);
    expect(bucket.remaining).toBe(0);

    vi.advanceTimersByTime(1500);
    expect(bucket.remaining).toBe(5);
  });
});

describe("Semaphore", () => {
  it("allows up to max concurrent acquisitions", async () => {
    const sem = new Semaphore(3);
    const release1 = await sem.acquire();
    const release2 = await sem.acquire();
    const release3 = await sem.acquire();

    expect(sem.tryAcquire()).toBeNull();

    release1();
    const release4 = sem.tryAcquire();
    expect(release4).not.toBeNull();
    release4!();
    release2();
    release3();

    const release5 = await sem.acquire();
    release5();
  });

  it("acquire waits for slot", async () => {
    const sem = new Semaphore(1);
    const release1 = await sem.acquire();

    let acquired = false;
    const acquirePromise = sem.acquire().then((release) => {
      acquired = true;
      release();
    });

    await Promise.resolve();
    expect(acquired).toBe(false);

    release1();
    await acquirePromise;
    expect(acquired).toBe(true);
  });

  it("tryAcquire returns null when full", () => {
    const sem = new Semaphore(0);
    expect(sem.tryAcquire()).toBeNull();
  });
});

describe("CircuitBreaker", () => {
  it("starts closed and allows requests", () => {
    const cb = new CircuitBreaker(5, 30_000);
    expect(cb.state).toBe("closed");
    expect(cb.allowRequest()).toBe(true);
  });

  it("opens after threshold failures", () => {
    const cb = new CircuitBreaker(3, 30_000);
    cb.onFailure();
    cb.onFailure();
    cb.onFailure();
    expect(cb.state).toBe("open");
    expect(cb.allowRequest()).toBe(false);
  });

  it("transitions to half-open after cooldown", () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker(2, 5000);
    cb.onFailure();
    cb.onFailure();
    expect(cb.state).toBe("open");
    expect(cb.allowRequest()).toBe(false);

    vi.advanceTimersByTime(5000);
    expect(cb.allowRequest()).toBe(true);
    expect(cb.state).toBe("half-open");

    vi.useRealTimers();
  });

  it("closes after success in half-open", () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker(2, 5000);
    cb.onFailure();
    cb.onFailure();
    expect(cb.state).toBe("open");

    vi.advanceTimersByTime(5000);
    expect(cb.allowRequest()).toBe(true);
    cb.onSuccess();
    expect(cb.state).toBe("closed");

    vi.useRealTimers();
  });

  it("re-opens on failure in half-open", () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker(2, 5000);
    cb.onFailure();
    cb.onFailure();
    expect(cb.state).toBe("open");

    vi.advanceTimersByTime(5000);
    expect(cb.allowRequest()).toBe(true);
    cb.onFailure();
    expect(cb.state).toBe("open");

    vi.useRealTimers();
  });

  it("serializes and deserializes state", () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker(3, 10_000);
    cb.onFailure();
    cb.onFailure();
    const json = cb.toJSON();

    expect(json.failureCount).toBe(2);
    expect(json.state).toBe("closed");
    expect(json.lastFailureTime).not.toBeNull();
    expect(json.failureThreshold).toBe(3);
    expect(json.cooldownMs).toBe(10_000);

    const restored = CircuitBreaker.fromJSON(json);
    expect(restored.state).toBe("closed");
    expect(restored.allowRequest()).toBe(true);

    restored.onFailure();
    expect(restored.state).toBe("open");
    vi.useRealTimers();
  });

  it("restores open state correctly", () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker(2, 5000);
    cb.onFailure();
    cb.onFailure();
    const json = cb.toJSON();
    expect(json.state).toBe("open");

    vi.advanceTimersByTime(5000);
    const restored = CircuitBreaker.fromJSON(json);
    expect(restored.state).toBe("open");
    expect(restored.allowRequest()).toBe(true);
    expect(restored.state).toBe("half-open");

    vi.useRealTimers();
  });
});
