import type { PerfBenchmark } from "./perf-benchmark";

function noopSetup(): Promise<void> {
  return Promise.resolve();
}

function generateLargeDiff(lineCount: number): string {
  const lines: string[] = [];
  let lineNum = 1;
  const hunks = Math.max(1, Math.floor(lineCount / 200));
  for (let h = 0; h < hunks; h++) {
    const hunkLines = Math.min(200, lineCount - h * 200);
    const ctx = Math.floor(hunkLines * 0.3);
    const del = Math.floor(hunkLines * 0.35);
    const add = hunkLines - ctx - del;
    lines.push(`diff --git a/file${h}.ts b/file${h}.ts`);
    lines.push(`--- a/file${h}.ts`);
    lines.push(`+++ b/file${h}.ts`);
    lines.push(`@@ -${lineNum},${del + ctx} +${lineNum},${add + ctx} @@`);
    for (let i = 0; i < ctx; i++) { lines.push(` ctx${i}`); }
    for (let i = 0; i < del; i++) { lines.push(`-del${i}`); }
    for (let i = 0; i < add; i++) { lines.push(`+add${i}`); }
    lineNum += hunkLines;
  }
  return lines.join("\n");
}

function generateMessages(count: number): Array<Record<string, unknown>> {
  const msgs: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i++) {
    msgs.push({ id: `msg-${i}`, role: i % 2 === 0 ? "user" : "assistant", content: "x".repeat(200), ts: Date.now() });
  }
  return msgs;
}

export const BENCHMARKS: PerfBenchmark[] = [
  {
    name: "lru.cache.10k.hits",
    setup: noopSetup,
    run: async () => {
      const { LruMap } = await import("../bounded-map");
      const map = new LruMap<number, number>(1000);
      for (let i = 0; i < 10000; i++) {
        map.set(i, i);
        map.get(i % 100);
      }
    },
    iterations: 100,
    warmupIterations: 10,
    target: { maxMs: 5, minOps: 200 },
  },
  {
    name: "bounded-map.set.10k",
    setup: noopSetup,
    run: async () => {
      const { BoundedMap } = await import("../bounded-map");
      const map = new BoundedMap<number, number>(100);
      for (let i = 0; i < 10000; i++) {
        map.set(i, i);
      }
    },
    iterations: 50,
    warmupIterations: 5,
    target: { maxMs: 10, minOps: 100 },
  },
  {
    name: "jsonl.append.1000",
    setup: async () => {
      const { mkdtemp } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const dir = await mkdtemp(join(tmpdir(), "crish-bench-"));
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(dir, "bench.jsonl"), "", "utf8");
      (globalThis as unknown as Record<string, string>).__benchDir = dir;
    },
    run: async () => {
      const { JsonlAppendBatcher } = await import("../jsonl-append-batcher");
      const dir = (globalThis as unknown as Record<string, string>).__benchDir;
      const batcher = new JsonlAppendBatcher({
        filePath: `${dir}/bench.jsonl`,
        flushIntervalMs: 0,
        flushCount: 1000,
        fsyncOnFlush: false,
        fsyncDirectoryOnFlush: false,
      });
      for (let i = 0; i < 1000; i++) {
        await batcher.append(JSON.stringify({ index: i, data: "x".repeat(64) }));
      }
      await batcher.flush();
      await batcher.close();
    },
    teardown: async () => {
      const { rm } = await import("node:fs/promises");
      const dir = (globalThis as unknown as Record<string, string>).__benchDir;
      await rm(dir, { recursive: true, force: true });
    },
    iterations: 20,
    warmupIterations: 5,
    target: { maxMs: 10, minOps: 100 },
  },
  {
    name: "deep-equal.1k.props",
    setup: noopSetup,
    run: async () => {
      const { deepEqual } = await import("../deep-equal");
      const a: Record<string, number> = {};
      const b: Record<string, number> = {};
      for (let i = 0; i < 1000; i++) {
        a[`k${i}`] = i;
        b[`k${i}`] = i;
      }
      deepEqual(a, b);
    },
    iterations: 100,
    warmupIterations: 10,
    target: { maxMs: 1, minOps: 1000 },
  },
  {
    name: "async-mutex.contention.100",
    setup: noopSetup,
    run: async () => {
      const { AsyncMutex } = await import("../async-mutex");
      const mutex = new AsyncMutex();
      const tasks = [];
      for (let i = 0; i < 100; i++) {
        tasks.push(
          mutex.runExclusive(async () => {
            await Promise.resolve();
            return i;
          }),
        );
      }
      await Promise.all(tasks);
    },
    iterations: 50,
    warmupIterations: 5,
    target: { maxMs: 5, minOps: 200 },
  },
  {
    name: "ring-buffer.10k.rw",
    setup: noopSetup,
    run: async () => {
      const { RingBuffer } = await import("../ring-buffer");
      const buf = new RingBuffer<number>(1000);
      for (let i = 0; i < 10000; i++) {
        buf.push(i);
        buf.peekFirst();
        buf.peekLast();
      }
    },
    iterations: 50,
    warmupIterations: 5,
    target: { maxMs: 5, minOps: 200 },
  },
  {
    name: "object.clone.1k",
    setup: noopSetup,
    run: async () => {
      const { clone } = await import("../object");
      const obj: Record<string, number> = {};
      for (let i = 0; i < 1000; i++) {
        obj[`k${i}`] = i;
      }
      clone(obj);
    },
    iterations: 100,
    warmupIterations: 10,
    target: { maxMs: 2, minOps: 500 },
  },
  {
    name: "diff.parse.10k",
    setup: noopSetup,
    run: async () => {
      const { StreamingDiffParser } = await import("../file/streaming-diff-parser");
      const diff = generateLargeDiff(10000);
      const parser = new StreamingDiffParser();
      parser.feed(diff);
      parser.flushRemaining();
    },
    iterations: 20,
    warmupIterations: 5,
    target: { maxMs: 50, minOps: 20 },
  },
  {
    name: "session.serialize.500msg",
    setup: noopSetup,
    run: async () => {
      const msgs = generateMessages(500);
      msgs.map((m) => JSON.stringify(m)).join("\n");
    },
    iterations: 30,
    warmupIterations: 5,
    target: { maxMs: 20, minOps: 50 },
  },
  {
    name: "cache.lru.10k",
    setup: noopSetup,
    run: async () => {
      const { LruMap } = await import("../bounded-map");
      const cache = new LruMap<string, number>(1000);
      for (let i = 0; i < 10000; i++) {
        cache.set(`k${i}`, i);
        cache.get(`k${i % 100}`);
      }
    },
    iterations: 100,
    warmupIterations: 10,
    target: { maxMs: 5, minOps: 200 },
  },
  {
    name: "mutex.contention.10",
    setup: noopSetup,
    run: async () => {
      const { AsyncMutex } = await import("../async-mutex");
      const mutex = new AsyncMutex();
      const tasks = [];
      for (let i = 0; i < 10; i++) {
        tasks.push(
          mutex.runExclusive(async () => {
            await Promise.resolve();
            return i;
          }),
        );
      }
      await Promise.all(tasks);
    },
    iterations: 50,
    warmupIterations: 5,
    target: { maxMs: 2, minOps: 500 },
  },
];
