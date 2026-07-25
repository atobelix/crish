import { describe, it, expect, beforeEach, vi } from "vitest";
import { AsyncMutex, AsyncSemaphore } from "./async-mutex";

beforeEach(() => {
  vi.useRealTimers();
});

describe("AsyncMutex", () => {
  it("serializes critical sections", async () => {
    const mutex = new AsyncMutex();
    const order: string[] = [];
    async function task(name: string, delayMs: number) {
      return mutex.runExclusive(async () => {
        order.push(`enter-${name}`);
        await new Promise((r) => setTimeout(r, delayMs));
        order.push(`exit-${name}`);
      });
    }
    await Promise.all([task("a", 10), task("b", 5), task("c", 1)]);
    // 严格串行：enter-a, exit-a, enter-b, exit-b, enter-c, exit-c
    expect(order).toEqual([
      "enter-a",
      "exit-a",
      "enter-b",
      "exit-b",
      "enter-c",
      "exit-c",
    ]);
  });

  it("returns the value from critical section", async () => {
    const mutex = new AsyncMutex();
    const result = await mutex.runExclusive(async () => 42);
    expect(result).toBe(42);
  });

  it("releases lock even if critical section throws", async () => {
    const mutex = new AsyncMutex();
    await expect(
      mutex.runExclusive(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    // 锁应该已释放
    expect(mutex.isLocked).toBe(false);
    const result = await mutex.runExclusive(async () => "ok");
    expect(result).toBe("ok");
  });

  it("respects FIFO ordering", async () => {
    const mutex = new AsyncMutex();
    const order: string[] = [];
    // 先占用锁
    const holder = mutex.acquire();
    const release = await holder;
    // 排队三个
    const p1 = mutex.runExclusive(async () => order.push("1"));
    const p2 = mutex.runExclusive(async () => order.push("2"));
    const p3 = mutex.runExclusive(async () => order.push("3"));
    release();
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual(["1", "2", "3"]);
  });
});

describe("AsyncSemaphore", () => {
  it("allows up to maxConcurrency concurrent tasks", async () => {
    const sem = new AsyncSemaphore(2);
    let active = 0;
    let maxActive = 0;
    async function task() {
      return sem.runExclusive(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active -= 1;
      });
    }
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(maxActive).toBe(2);
  });

  it("releases slot on error", async () => {
    const sem = new AsyncSemaphore(1);
    await expect(
      sem.runExclusive(async () => {
        throw new Error("fail");
      })
    ).rejects.toThrow("fail");
    const result = await sem.runExclusive(async () => "ok");
    expect(result).toBe("ok");
  });
});

describe("AsyncMutex recursive release stack overflow", () => {
  it("should not stack overflow when 500 aborted tasks are queued", async () => {
    const mutex = new AsyncMutex();
    const controller = new AbortController();
    const firstRelease = await mutex.acquire();
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 500; i++) {
      promises.push(mutex.acquire(controller.signal).catch(() => {}));
    }
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(() => firstRelease()).not.toThrow();
    await Promise.allSettled(promises);
    expect(mutex.isLocked).toBe(false);
  });
});

describe("AsyncSemaphore recursive release stack overflow", () => {
  it("should not stack overflow when 500 aborted tasks are queued", async () => {
    const semaphore = new AsyncSemaphore(1);
    const controller = new AbortController();
    const firstRelease = await semaphore.acquire();
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 500; i++) {
      promises.push(semaphore.acquire(controller.signal).catch(() => {}));
    }
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(() => firstRelease()).not.toThrow();
    await Promise.allSettled(promises);
    expect(semaphore.activeCount).toBe(0);
  });
});
