import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamingJsonlReader } from "./streaming-jsonl-reader";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crish-jsonl-reader-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
  }
});

describe("StreamingJsonlReader", () => {
  it("reads header and entries correctly", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "with-header.jsonl");
    await writeFile(
      filePath,
      '{"version":1,"type":"session"}\n{"id":1,"msg":"hello"}\n{"id":2,"msg":"world"}\n',
      "utf8",
    );

    const reader = new StreamingJsonlReader(filePath);
    await reader.open();
    const header = await reader.readHeader();
    expect(header).toEqual({ version: 1, type: "session" });

    const entries: Array<{ id: number; msg: string }> = [];
    for await (const entry of reader.readEntries<{ id: number; msg: string }>()) {
      entries.push(entry);
    }
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ id: 1, msg: "hello" });
    expect(entries[1]).toEqual({ id: 2, msg: "world" });
    await reader.close();
  });

  it("skips malformed lines without throwing", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "malformed.jsonl");
    await writeFile(
      filePath,
      '{"ok":1}\nnot-json\n{"ok":2}\n{truncated\n{"ok":3}\n',
      "utf8",
    );

    const reader = new StreamingJsonlReader(filePath, { hasHeader: false });
    await reader.open();
    const entries = await reader.readAll<{ ok: number }>();
    expect(entries).toEqual([{ ok: 1 }, { ok: 2 }, { ok: 3 }]);
    await reader.close();
  });

  it("returns null header for empty file", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "empty.jsonl");
    await writeFile(filePath, "", "utf8");

    const reader = new StreamingJsonlReader(filePath);
    await reader.open();
    const header = await reader.readHeader();
    expect(header).toBeNull();
    await reader.close();
  });

  it("readAll returns all entries", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "readall.jsonl");
    await writeFile(
      filePath,
      '{"n":1}\n{"n":2}\n{"n":3}\n',
      "utf8",
    );

    const reader = new StreamingJsonlReader(filePath, { hasHeader: false });
    await reader.open();
    const entries = await reader.readAll<{ n: number }>();
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({ n: 1 });
    expect(entries[2]).toEqual({ n: 3 });
    await reader.close();
  });

  it("handles file with only header and no entries", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "header-only.jsonl");
    await writeFile(filePath, '{"type":"empty"}\n', "utf8");

    const reader = new StreamingJsonlReader(filePath);
    await reader.open();
    const header = await reader.readHeader();
    expect(header).toEqual({ type: "empty" });
    const entries = await reader.readAll<unknown>();
    expect(entries).toHaveLength(0);
    await reader.close();
  });

  it("handles hasHeader=false correctly", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "no-header.jsonl");
    await writeFile(filePath, '{"a":1}\n{"a":2}\n', "utf8");

    const reader = new StreamingJsonlReader(filePath, { hasHeader: false });
    await reader.open();
    const header = await reader.readHeader();
    // hasHeader=false, header 读取第一行作为 entry
    expect(header).toEqual({ a: 1 });
    // readEntries 不应跳过第一行
    const entries = await reader.readAll<{ a: number }>();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ a: 2 });
    await reader.close();
  });
});
