import { describe, expect, it } from 'vitest';
import { chunkMarkdown, hash16 } from './markdownChunker';

describe('chunkMarkdown', () => {
  it('groups blocks into bounded chunks without dropping content', () => {
    const blocks = Array.from({ length: 5 }, (_, i) =>
      `paragraph ${i}`.repeat(20)
    );
    const chunks = chunkMarkdown(blocks.join('\n\n'), 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.id).toMatch(/^md-chunk-/);
      expect(chunk.text.length).toBeGreaterThan(0);
    }
    const joined = chunks.map((chunk) => chunk.text).join('\n\n');
    for (const block of blocks) expect(joined).toContain(block);
  });

  it('empty input produces no chunks', () => {
    expect(chunkMarkdown('')).toEqual([]);
    expect(chunkMarkdown('\n\n')).toEqual([]);
  });

  it('chunk ids are content-addressed and stable', () => {
    const a = chunkMarkdown('para one\n\npara two');
    const b = chunkMarkdown('para one\n\npara two');
    expect(a.map((chunk) => chunk.id)).toEqual(b.map((chunk) => chunk.id));
    expect(a[0]?.id).toMatch(/^md-chunk-0-[0-9a-f]{16}$/);
  });
});

describe('hash16', () => {
  it('is stable and distinguishes content', () => {
    expect(hash16('abc')).toBe(hash16('abc'));
    expect(hash16('abc')).not.toBe(hash16('abd'));
    expect(hash16('abc')).toMatch(/^[0-9a-f]{16}$/);
  });
});
