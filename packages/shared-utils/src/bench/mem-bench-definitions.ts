import type { MemBenchmark } from "./mem-benchmark";

export const MEM_BENCHMARKS: MemBenchmark[] = [
  {
    name: "cache.eviction.no-leak",
    execute: async () => {
      const { BoundedMap } = await import("../bounded-map");
      const map = new BoundedMap<number, Uint8Array>(100);
      for (let i = 0; i < 10000; i++) {
        map.set(i, new Uint8Array(1024));
      }
    },
    expectedMaxHeapDelta: 1024 * 1024,
    expectedMaxEventListenerLeak: 0,
  },
  {
    name: "lru-map.no-leak",
    execute: async () => {
      const { LruMap } = await import("../bounded-map");
      const map = new LruMap<number, Uint8Array>(100);
      for (let i = 0; i < 10000; i++) {
        map.set(i, new Uint8Array(1024));
        map.get(Math.floor(Math.random() * i));
      }
    },
    expectedMaxHeapDelta: 1024 * 1024,
    expectedMaxEventListenerLeak: 0,
  },
  {
    name: "ring-buffer.no-leak",
    execute: async () => {
      const { RingBuffer } = await import("../ring-buffer");
      const buf = new RingBuffer<Uint8Array>(100);
      for (let i = 0; i < 5000; i++) {
        buf.push(new Uint8Array(512));
      }
    },
    expectedMaxHeapDelta: 200 * 1024,
    expectedMaxEventListenerLeak: 0,
  },
  {
    name: "async-mutex.no-leak",
    execute: async () => {
      const { AsyncMutex } = await import("../async-mutex");
      const mutex = new AsyncMutex();
      for (let i = 0; i < 100; i++) {
        await mutex.runExclusive(async () => {
          await Promise.resolve();
        });
      }
    },
    expectedMaxHeapDelta: 50 * 1024,
    expectedMaxEventListenerLeak: 0,
  },
  {
    name: "jsonl-batcher.no-leak",
    execute: async () => {
      const { JsonlAppendBatcher } = await import("../jsonl-append-batcher");
      const { mkdtemp, rm } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const dir = await mkdtemp(join(tmpdir(), "crish-mem-bench-"));
      const filePath = join(dir, "mem.jsonl");
      const batcher = new JsonlAppendBatcher({
        filePath,
        flushIntervalMs: 0,
        flushCount: 100,
        fsyncOnFlush: false,
        fsyncDirectoryOnFlush: false,
      });
      for (let i = 0; i < 500; i++) {
        await batcher.append(JSON.stringify({ i }));
      }
      await batcher.close();
      await rm(dir, { recursive: true, force: true });
    },
    expectedMaxHeapDelta: 200 * 1024,
    expectedMaxEventListenerLeak: 0,
  },
];
