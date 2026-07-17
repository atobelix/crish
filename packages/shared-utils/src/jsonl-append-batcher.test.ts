import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlAppendBatcher } from "./jsonl-append-batcher";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crish-jsonl-batcher-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
  }
});

describe("JsonlAppendBatcher", () => {
  it("appends lines and flushes to disk", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "log.jsonl");
    const batcher = new JsonlAppendBatcher({
      filePath,
      flushIntervalMs: 0,
      flushCount: 1,
      fsyncOnFlush: false,
      fsyncDirectoryOnFlush: false,
    });
    await batcher.append(JSON.stringify({ n: 1 }));
    await batcher.append(JSON.stringify({ n: 2 }));
    await batcher.flush();
    await batcher.close();
    const content = await readFile(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ n: 1 });
    expect(JSON.parse(lines[1])).toEqual({ n: 2 });
  });

  it("batches multiple lines into a single flush", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "log.jsonl");
    const batcher = new JsonlAppendBatcher({
      filePath,
      flushIntervalMs: 1000,
      flushCount: 3,
      fsyncOnFlush: false,
      fsyncDirectoryOnFlush: false,
    });
    await batcher.append("a");
    await batcher.append("b");
    // 此时不应落盘（pendingCount < 3 且 timer 未触发）
    let content = "";
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      // 文件可能不存在
    }
    expect(content).toBe("");
    await batcher.append("c"); // 触发 flushCount=3
    await batcher.flush();
    await batcher.close();
    content = await readFile(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines).toEqual(["a", "b", "c"]);
  });

  it("auto-flushes after flushIntervalMs", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "log.jsonl");
    const batcher = new JsonlAppendBatcher({
      filePath,
      flushIntervalMs: 30,
      flushCount: 100,
      fsyncOnFlush: false,
      fsyncDirectoryOnFlush: false,
    });
    await batcher.append("x");
    // 等待 timer 触发
    await new Promise((r) => setTimeout(r, 100));
    const content = await readFile(filePath, "utf8");
    expect(content).toBe("x\n");
    await batcher.close();
  });

  it("ensures leading newline if file does not end with one", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "log.jsonl");
    // 预先写一个不带换行的文件
    await writeFile(filePath, "no-newline-here", "utf8");
    const batcher = new JsonlAppendBatcher({
      filePath,
      flushIntervalMs: 0,
      flushCount: 1,
      fsyncOnFlush: false,
      fsyncDirectoryOnFlush: false,
    });
    await batcher.append("second");
    await batcher.flush();
    await batcher.close();
    const content = await readFile(filePath, "utf8");
    // 应自动补一个换行
    expect(content).toBe("no-newline-here\nsecond\n");
  });

  it("close flushes remaining pending data", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "log.jsonl");
    const batcher = new JsonlAppendBatcher({
      filePath,
      flushIntervalMs: 10000,
      flushCount: 100,
      fsyncOnFlush: false,
      fsyncDirectoryOnFlush: false,
    });
    await batcher.append("pending1");
    await batcher.append("pending2");
    await batcher.close();
    const content = await readFile(filePath, "utf8");
    expect(content).toBe("pending1\npending2\n");
  });

  it("creates file that grows in size", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "log.jsonl");
    const batcher = new JsonlAppendBatcher({
      filePath,
      flushIntervalMs: 0,
      flushCount: 1,
      fsyncOnFlush: false,
      fsyncDirectoryOnFlush: false,
    });
    for (let i = 0; i < 5; i++) {
      await batcher.append(`line-${i}`);
    }
    await batcher.close();
    const s = await stat(filePath);
    expect(s.size).toBeGreaterThan(0);
  });

  it("tolerates directory fsync failure on tmpfs", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "log.jsonl");
    const batcher = new JsonlAppendBatcher({
      filePath,
      flushIntervalMs: 0,
      flushCount: 1,
      // 默认 fsyncDirectoryOnFlush=true，但用 best-effort 模式
    });
    await batcher.append("ok");
    await batcher.flush();
    await batcher.close();
    const content = await readFile(filePath, "utf8");
    expect(content).toBe("ok\n");
  });
});
