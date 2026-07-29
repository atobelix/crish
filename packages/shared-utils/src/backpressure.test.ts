import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Semaphore, TokenBucket } from './backpressure';

describe('TokenBucket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows consuming within capacity', () => {
    const bucket = new TokenBucket(10, 10);
    expect(bucket.tryConsume(5)).toBe(true);
    expect(bucket.remaining).toBe(5);
  });

  it('rejects when insufficient tokens', () => {
    const bucket = new TokenBucket(5, 5);
    expect(bucket.tryConsume(6)).toBe(false);
    expect(bucket.remaining).toBe(5);
  });

  it('refills tokens over time', () => {
    const bucket = new TokenBucket(10, 5, 1000);
    expect(bucket.tryConsume(10)).toBe(true);
    expect(bucket.remaining).toBe(0);

    vi.advanceTimersByTime(2000);
    expect(bucket.remaining).toBe(10);
    expect(bucket.tryConsume(5)).toBe(true);
  });

  it('does not exceed capacity', () => {
    const bucket = new TokenBucket(10, 100, 1000);
    expect(bucket.tryConsume(5)).toBe(true);
    expect(bucket.remaining).toBe(5);

    vi.advanceTimersByTime(5000);
    expect(bucket.remaining).toBe(10);
  });

  it('handles partial refill intervals', () => {
    const bucket = new TokenBucket(10, 5, 1000);
    expect(bucket.tryConsume(10)).toBe(true);
    expect(bucket.remaining).toBe(0);

    vi.advanceTimersByTime(1500);
    expect(bucket.remaining).toBe(5);
  });
});

describe('Semaphore', () => {
  it('allows up to max concurrent acquisitions', async () => {
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

  it('acquire waits for slot', async () => {
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

  it('tryAcquire returns null when full', () => {
    const sem = new Semaphore(0);
    expect(sem.tryAcquire()).toBeNull();
  });
});
