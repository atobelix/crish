import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamingFileReader } from "./streaming-file-reader";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crish-stream-reader-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
  }
});

describe("StreamingFileReader", () => {
  it("reads small file (< chunkSize) correctly", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "small.txt");
    await writeFile(filePath, "hello world", "utf8");

    const reader = new StreamingFileReader(filePath, { highWaterMark: 65536 });
    await reader.open();
    const chunk = await reader.readNextBytes();
    expect(chunk).not.toBeNull();
    expect(chunk!.toString("utf8")).toBe("hello world");
    expect(reader.position).toBe(11);
    expect(reader.size).toBe(11);
    // 第二次应返回 null
    expect(await reader.readNextBytes()).toBeNull();
    await reader.close();
    expect(reader.closed).toBe(true);
  });

  it("reads large file (> chunkSize) in chunks", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "large.txt");
    // 写入 100KB 数据
    const content = "x".repeat(100 * 1024);
    await writeFile(filePath, content, "utf8");

    const reader = new StreamingFileReader(filePath, { highWaterMark: 16384 });
    await reader.open();
    let totalBytes = 0;
    let chunks = 0;
    let chunk = await reader.readNextBytes();
    while (chunk !== null) {
      totalBytes += chunk.length;
      chunks++;
      chunk = await reader.readNextBytes();
    }
    expect(totalBytes).toBe(100 * 1024);
    expect(chunks).toBeGreaterThan(1);
    await reader.close();
  });

  it("readLines returns correct number of lines", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "lines.txt");
    await writeFile(filePath, "a\nb\nc\nd\ne\n", "utf8");

    const reader = new StreamingFileReader(filePath);
    await reader.open();
    const lines = await reader.readLines(3);
    expect(lines).toEqual(["a", "b", "c"]);
    await reader.close();
  });

  it("readLines with limit larger than file returns all lines", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "few-lines.txt");
    await writeFile(filePath, "1\n2\n", "utf8");

    const reader = new StreamingFileReader(filePath);
    await reader.open();
    const lines = await reader.readLines(100);
    expect(lines).toEqual(["1", "2"]);
    await reader.close();
  });

  it("async iterator yields lines correctly", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "iter.txt");
    await writeFile(filePath, "line1\nline2\nline3\n", "utf8");

    const reader = new StreamingFileReader(filePath);
    await reader.open();
    const lines: string[] = [];
    for await (const line of reader) {
      lines.push(line);
    }
    expect(lines).toEqual(["line1", "line2", "line3"]);
    await reader.close();
  });

  it("handles cross-chunk line boundaries", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "cross-chunk.txt");
    // 写 3 行，每行略小于 8KB，确保分块可能跨行
    const line = "x".repeat(7000) + "\n";
    await writeFile(filePath, line.repeat(3), "utf8");

    const reader = new StreamingFileReader(filePath, { highWaterMark: 8192 });
    await reader.open();
    const lines: string[] = [];
    for await (const l of reader) {
      lines.push(l);
    }
    expect(lines).toHaveLength(3);
    expect(lines[0]).toHaveLength(7000);
    expect(lines[1]).toHaveLength(7000);
    expect(lines[2]).toHaveLength(7000);
    await reader.close();
  });

  it("returns empty for empty file", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "empty.txt");
    await writeFile(filePath, "", "utf8");

    const reader = new StreamingFileReader(filePath);
    await reader.open();
    const chunk = await reader.readNextBytes();
    expect(chunk).toBeNull();
    const lines = await reader.readLines(10);
    expect(lines).toEqual([]);
    await reader.close();
  });

  it("throws error for non-existent file", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "nonexistent.txt");
    const reader = new StreamingFileReader(filePath);
    await expect(reader.open()).rejects.toThrow();
  });

  it("readLines works with file without trailing newline", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "no-trailing-nl.txt");
    await writeFile(filePath, "foo\nbar", "utf8");

    const reader = new StreamingFileReader(filePath);
    await reader.open();
    const lines = await reader.readLines(10);
    expect(lines).toEqual(["foo", "bar"]);
    await reader.close();
  });

  it("close is idempotent", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "idempotent.txt");
    await writeFile(filePath, "data", "utf8");

    const reader = new StreamingFileReader(filePath);
    await reader.open();
    await reader.close();
    await reader.close(); // 不应抛异常
    expect(reader.closed).toBe(true);
  });
});
