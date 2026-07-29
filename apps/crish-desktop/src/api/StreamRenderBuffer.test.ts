import { describe, expect, it } from 'vitest';
import {
  flushFrame,
  safeUnicodeCutPosition,
  StreamRenderBuffer,
} from './StreamRenderBuffer';

describe('StreamRenderBuffer', () => {
  it('should handle surrogate pair at split boundary', () => {
    const text = 'hello 😀 world';
    // Position 7 falls between the high (0xD83D) and low (0xDE00) surrogates of 😀
    const safeCut = safeUnicodeCutPosition(text, 7);
    expect(safeCut).toBe(6);
    expect(text.slice(0, safeCut)).toBe('hello ');
  });

  it('should handle nlIndex truncation with surrogate pairs', () => {
    const result = flushFrame(['hello 😀 world'], 7, performance.now() + 1000, false);
    expect(result.batch).toEqual(['hello ']);
    expect(result.remaining).toEqual(['😀 world']);
  });

  it('should handle deadline truncation with surrogate pairs', () => {
    // Expired deadline forces batching to stop after the first chunk without breaking the next surrogate chunk
    const result = flushFrame(['hello ', '😀 world'], 100, performance.now() - 10, false);
    expect(result.batch).toEqual(['hello ']);
    expect(result.remaining).toEqual(['😀 world']);
  });

  it('frames carry html as string and chunkUpdates as empty array', () => {
    const buf = new StreamRenderBuffer();
    const frames: { full: string; html: string; chunkUpdates: unknown[]; isFinal: boolean }[] = [];
    buf.onFrame = (frame) => {
      frames.push({
        full: frame.full,
        html: frame.html,
        chunkUpdates: frame.chunkUpdates,
        isFinal: frame.isFinal,
      });
    };

    buf.push('hello ');
    buf.push('world');
    buf.push('!', true);
    buf.flush(true);

    expect(frames.length).toBeGreaterThan(0);
    const last = frames[frames.length - 1]!;
    expect(last.full).toBe('hello world!');
    // html 类型为 string：JS 增量解析器接入前为 ''，接入后可携带非空 HTML
    expect(typeof last.html).toBe('string');
    expect(last.chunkUpdates).toEqual([]);
    expect(last.isFinal).toBe(true);
  });

  it('constructor no longer accepts htmlNeeded option (bridge removed)', () => {
    // htmlNeeded 已废弃：构造函数不接受该参数
    // frame.html 为 string 类型：解析器接入前为 ''，接入后可携带非空 HTML
    const buf = new StreamRenderBuffer();
    let lastHtml: string | null = null;
    buf.onFrame = (frame) => {
      lastHtml = frame.html;
    };

    buf.push('hello', true);
    buf.flush(true);

    expect(typeof lastHtml).toBe('string');
  });
});
