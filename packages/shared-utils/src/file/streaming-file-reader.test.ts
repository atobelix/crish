import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamingFileReader } from './streaming-file-reader';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'crish-stream-reader-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    await import('node:fs/promises').then((fs) =>
      fs.rm(dir, { recursive: true, force: true })
    );
  }
});

describe('StreamingFileReader', () => {
  it('reads small file (< chunkSize) correctly', async () => {
    const dir = await tempDir();
    const filePath = join(dir, 'small.txt');
    await writeFile(filePath, 'hello world', 'utf8');

    const reader = new StreamingFileReader(filePath, { highWaterMark: 65536 });
    await reader.open();
    const chunk = await reader.readNextBytes();
    expect(chunk).not.toBeNull();
    expect(chunk!.toString('utf8')).toBe('hello world');
    expect(reader.position).toBe(11);
    expect(reader.size).toBe(11);
    // 第二次应返回 null
    expect(await reader.readNextBytes()).toBeNull();
    await reader.close();
    expect(reader.closed).toBe(true);
  });

  it('reads large file (> chunkSize) in chunks', async () => {
    const dir = await tempDir();
    const filePath = join(dir, 'large.txt');
    // 写入 100KB 数据
    const content = 'x'.repeat(100 * 1024);
    await writeFile(filePath, content, 'utf8');

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

  it('readLines returns correct number of lines', async () => {
    const dir = await tempDir();
    const filePath = join(dir, 'lines.txt');
    await writeFile(filePath, 'a\nb\nc\nd\ne\n', 'utf8');

    const reader = new StreamingFileReader(filePath);
    await reader.open();
    const lines = await reader.readLines(3);
    expect(lines).toEqual(['a', 'b', 'c']);
    await reader.close();
  });

  it('readLines with limit larger than file returns all lines', async () => {
    const dir = await tempDir();
    const filePath = join(dir, 'few-lines.txt');
    await writeFile(filePath, '1\n2\n', 'utf8');

    const reader = new StreamingFileReader(filePath);
    await reader.open();
    const lines = await reader.readLines(100);
    expect(lines).toEqual(['1', '2']);
    await reader.close();
  });

  it('async iterator yields lines correctly', async () => {
    const dir = await tempDir();
    const filePath = join(dir, 'iter.txt');
    await writeFile(filePath, 'line1\nline2\nline3\n', 'utf8');

    const reader = new StreamingFileReader(filePath);
    await reader.open();
    const lines: string[] = [];
    for await (const line of reader) {
      lines.push(line);
    }
    expect(lines).toEqual(['line1', 'line2', 'line3']);
    await reader.close();
  });

  it('handles cross-chunk line boundaries', async () => {
    const dir = await tempDir();
    const filePath = join(dir, 'cross-chunk.txt');
    // 写 3 行，每行略小于 8KB，确保分块可能跨行
    const line = 'x'.repeat(7000) + '\n';
    await writeFile(filePath, line.repeat(3), 'utf8');

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

  it('returns empty for empty file', async () => {
    const dir = await tempDir();
    const filePath = join(dir, 'empty.txt');
    await writeFile(filePath, '', 'utf8');

    const reader = new StreamingFileReader(filePath);
    await reader.open();
    const chunk = await reader.readNextBytes();
    expect(chunk).toBeNull();
    const lines = await reader.readLines(10);
    expect(lines).toEqual([]);
    await reader.close();
  });

  it('throws error for non-existent file', async () => {
    const dir = await tempDir();
    const filePath = join(dir, 'nonexistent.txt');
    const reader = new StreamingFileReader(filePath);
    await expect(reader.open()).rejects.toThrow();
  });

  it('readLines works with file without trailing newline', async () => {
    const dir = await tempDir();
    const filePath = join(dir, 'no-trailing-nl.txt');
    await writeFile(filePath, 'foo\nbar', 'utf8');

    const reader = new StreamingFileReader(filePath);
    await reader.open();
    const lines = await reader.readLines(10);
    expect(lines).toEqual(['foo', 'bar']);
    await reader.close();
  });

  it('close is idempotent', async () => {
    const dir = await tempDir();
    const filePath = join(dir, 'idempotent.txt');
    await writeFile(filePath, 'data', 'utf8');

    const reader = new StreamingFileReader(filePath);
    await reader.open();
    await reader.close();
    await reader.close(); // 不应抛异常
    expect(reader.closed).toBe(true);
  });
});

describe('T3.8 D8 UTF-8 跨块解码（F8-04：跨块半字符 U+FFFD 污染）', () => {
  /** 断言读出的每一行均无 U+FFFD 且与 readFileSync 全等（尾部空行语义对齐） */
  async function assertCleanLines(
    filePath: string,
    highWaterMark: number,
    readLines: boolean
  ): Promise<void> {
    const reader = new StreamingFileReader(filePath, { highWaterMark });
    await reader.open();
    const lines: string[] = [];
    if (readLines) {
      // 上限取足够大以读完整文件（64KB 用例 5000 行）
      lines.push(...(await reader.readLines(100000)));
    } else {
      for await (const line of reader) {
        lines.push(line);
      }
    }
    await reader.close();

    const expected = readFileSync(filePath, 'utf8').split('\n');
    // readFileSync split 尾部的空串（文件以 \n 结尾）与流式读取不产出尾空行的语义对齐
    const expectedLines =
      expected[expected.length - 1] === '' ? expected.slice(0, -1) : expected;
    for (const line of lines) {
      // 修复前 chunk.toString("utf8") 把跨块半字节替换为 U+FFFD，此断言红
      expect(line).not.toContain('\uFFFD');
    }
    expect(lines).toEqual(expectedLines);
  }

  it('multibyte_char_across_chunk_boundary_not_corrupted：跨块「中」不被 U+FFFD 污染（readLines 路径）', async () => {
    const dir = await tempDir();
    const filePath = join(dir, 'cn-boundary.txt');
    // 3 字节 ASCII + 中（E4 B8 AD）+ \n + 多行中文；highWaterMark=4 使
    // 「中」的第一字节与后两字节分属两块（精确复刻 64KB 边界命中）
    const content = 'abc中\n中文第一行\n中文第二行\n';
    await writeFile(filePath, content, 'utf8');

    await assertCleanLines(filePath, 4, true);
  });

  it('async_iterator_multibyte_boundary_clean：同内容走 for await 路径一致无污染', async () => {
    const dir = await tempDir();
    const filePath = join(dir, 'cn-boundary-iter.txt');
    const content = 'abc中\n中文第一行\n中文第二行\n';
    await writeFile(filePath, content, 'utf8');

    await assertCleanLines(filePath, 4, false);
  });

  it('emoji_four_byte_boundary_clean：😀（F0 9F 98 80）四字节跨界不损坏', async () => {
    const dir = await tempDir();
    const filePath = join(dir, 'emoji-boundary.txt');
    // block=3 使 😀 的首字节 F0 与后三字节分属不同块
    const content = 'A😀\n😀B\n';
    await writeFile(filePath, content, 'utf8');

    await assertCleanLines(filePath, 3, true);
    await assertCleanLines(filePath, 3, false);
  });

  it('mixed_64kb_boundary_clean：64KB 级块大小下多行中文全文一致（真实命中面）', async () => {
    const dir = await tempDir();
    const filePath = join(dir, 'cn-64kb.txt');
    // 5 万行中文，总大小超过 64KB，行内容使字符跨越多个块边界
    const line = '这是一行用于跨块边界测试的中文内容';
    const content = Array(5000).fill(line).join('\n') + '\n';
    await writeFile(filePath, content, 'utf8');

    await assertCleanLines(filePath, 65536, true);
    await assertCleanLines(filePath, 65536, false);
  });
});
