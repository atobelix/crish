import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushFrame,
  safeGraphemeCutPosition,
  safeUnicodeCutPosition,
  StreamRenderBuffer,
} from './StreamRenderBuffer';
import type { RenderFrame } from './StreamRenderBuffer';

/**
 * 注意：构造函数将 maxBytesPerFrame 钳位到 Math.max(64, value)，
 * 因此单元测试中使用的 maxBytesPerFrame 必须 ≥ 64。
 * （G13 layer-0-reverse：本测试原误放于 packages/shared-utils/src/__tests__/，
 *   反向引用应用层；已就近迁移至 api/ 目录并合并。）
 */

function loneSurrogates(s: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdfff) {
      const isHigh = code <= 0xdbff;
      const next = s.charCodeAt(i + 1);
      if (isHigh && next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      count++;
    }
  }
  return count;
}

beforeEach(() => {
  vi.stubGlobal('Worker', undefined);
  vi.stubGlobal('requestAnimationFrame', vi.fn());
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('StreamRenderBuffer', () => {
  it('should handle surrogate pair at split boundary', () => {
    const text = 'hello 😀 world';
    // Position 7 falls between the high (0xD83D) and low (0xDE00) surrogates of 😀
    const safeCut = safeUnicodeCutPosition(text, 7);
    expect(safeCut).toBe(6);
    expect(text.slice(0, safeCut)).toBe('hello ');
  });

  it('should handle nlIndex truncation with surrogate pairs', () => {
    const result = flushFrame(
      ['hello 😀 world'],
      7,
      performance.now() + 1000,
      false
    );
    expect(result.batch).toEqual(['hello ']);
    expect(result.remaining).toEqual(['😀 world']);
  });

  it('should handle deadline truncation with surrogate pairs', () => {
    // Expired deadline forces batching to stop after the first chunk without breaking the next surrogate chunk
    const result = flushFrame(
      ['hello ', '😀 world'],
      100,
      performance.now() - 10,
      false
    );
    expect(result.batch).toEqual(['hello ']);
    expect(result.remaining).toEqual(['😀 world']);
  });

  it('frames carry html as string and chunkUpdates as empty array', () => {
    const buf = new StreamRenderBuffer();
    const frames: {
      full: string;
      html: string;
      chunkUpdates: unknown[];
      isFinal: boolean;
    }[] = [];
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

// ──────────────────────────────────────────────
describe('正常分帧', () => {
  it('超过 maxBytesPerFrame 的数据拆分为多帧', async () => {
    // maxBytesPerFrame 钳位到 ≥ 64，用 100 配合 60 字节块：60<100, 60+60>100
    const buf = new StreamRenderBuffer({ maxBytesPerFrame: 100 });
    const frames: RenderFrame[] = [];
    buf.onFrame = (f) => frames.push(f);

    buf.push('a'.repeat(60));
    buf.push('b'.repeat(60));
    buf.push('c'.repeat(60));

    await buf.flush(false); // → frame: "a"*60
    await buf.flush(false); // → frame: "b"*60
    await buf.flush(true); // → frame: "c"*60

    expect(frames.length).toBeGreaterThanOrEqual(2);
    for (const f of frames) {
      expect(f.delta.length).toBeLessThanOrEqual(100);
    }
    const allDelta = frames.map((f) => f.delta).join('');
    expect(allDelta).toBe('a'.repeat(60) + 'b'.repeat(60) + 'c'.repeat(60));
  });

  it('单帧不超过限制时不拆分', async () => {
    const buf = new StreamRenderBuffer({ maxBytesPerFrame: 100 });
    const frames: RenderFrame[] = [];
    buf.onFrame = (f) => frames.push(f);

    buf.push('hello world');
    await buf.flush(true);

    expect(frames).toHaveLength(1);
    expect(frames[0]!.delta).toBe('hello world');
  });

  it('换行符边界友好分割', async () => {
    const buf = new StreamRenderBuffer({ maxBytesPerFrame: 64 });
    const frames: RenderFrame[] = [];
    buf.onFrame = (f) => frames.push(f);

    buf.push('line A\nline BB\nline CCC\nline DDDD\n');
    await buf.flush(true);

    const allDelta = frames.map((f) => f.delta).join('');
    expect(allDelta).toBe('line A\nline BB\nline CCC\nline DDDD\n');
  });
});

// ──────────────────────────────────────────────
describe('maxBacklogBytes 降级跳帧', () => {
  it('积压超过 maxBacklogBytes 时 degraded=true', async () => {
    const buf = new StreamRenderBuffer({
      maxBytesPerFrame: 64,
      maxBacklogBytes: 30,
    });
    const frames: RenderFrame[] = [];
    buf.onFrame = (f) => frames.push(f);

    // Push well past maxBytesPerFrame so flush(false) leaves remaining pending.
    // degraded = remaining bufferedLength() > maxBacklogBytes after this frame.
    // 12 × 20 B = 240 B total → first frame takes ~60 B (3 chunks), remaining ~180 > 30.
    for (let i = 0; i < 12; i++) {
      buf.push('x'.repeat(20));
    }

    await buf.flush(false);

    const degradedFrames = frames.filter((f) => f.degraded);
    expect(degradedFrames.length).toBeGreaterThanOrEqual(1);
    for (const f of degradedFrames) {
      expect(f.html).toBe('');
      expect(f.chunkUpdates).toEqual([]);
    }
  });

  it('积压在 maxBacklogBytes 以内时不降级', async () => {
    const buf = new StreamRenderBuffer({
      maxBytesPerFrame: 64,
      maxBacklogBytes: 100,
    });
    const frames: RenderFrame[] = [];
    buf.onFrame = (f) => frames.push(f);

    for (let i = 0; i < 3; i++) {
      buf.push('x'.repeat(10));
    }

    await buf.flush(false);

    for (const f of frames) {
      expect(f.degraded).toBe(false);
    }
  });

  it('flush(true) 时即使积压大也不 degraded', async () => {
    const buf = new StreamRenderBuffer({
      maxBytesPerFrame: 64,
      maxBacklogBytes: 30,
    });
    const frames: RenderFrame[] = [];
    buf.onFrame = (f) => frames.push(f);

    for (let i = 0; i < 6; i++) {
      buf.push('x'.repeat(10));
    }

    await buf.flush(true);

    for (const f of frames) {
      expect(f.degraded).toBe(false);
    }
  });
});

// ──────────────────────────────────────────────
describe('flush(true) 强制', () => {
  it('无视 maxBytesPerFrame 一次性刷完', async () => {
    const buf = new StreamRenderBuffer({ maxBytesPerFrame: 64 });
    const frames: RenderFrame[] = [];
    buf.onFrame = (f) => frames.push(f);

    buf.push('hello '.repeat(50));
    await buf.flush(true);

    expect(frames).toHaveLength(1);
    expect(frames[0]!.delta).toBe('hello '.repeat(50));
  });

  it('刷完 pending 为空', async () => {
    const buf = new StreamRenderBuffer({ maxBytesPerFrame: 64 });

    buf.push('x'.repeat(100));
    await buf.flush(true);

    expect(buf.bufferedLength()).toBe(0);
  });
});

// ──────────────────────────────────────────────
describe('UTF-8 安全截断（4 字节 emoji）', () => {
  it('不切断 surrogate pair', async () => {
    const buf = new StreamRenderBuffer({ maxBytesPerFrame: 64 });
    const frames: RenderFrame[] = [];
    buf.onFrame = (f) => frames.push(f);

    // 😀 = U+1F600 → surrogate pair \uD83D\uDE00
    const emoji = '😀';
    const s = 'A'.repeat(30) + emoji + 'B'.repeat(30);

    buf.push(s);
    await buf.flush(true);

    const allDelta = frames.map((f) => f.delta).join('');
    expect(allDelta).toBe(s);

    for (const f of frames) {
      expect(loneSurrogates(f.delta)).toBe(0);
    }
  });

  it('多个 emoji 跨帧时完整性', async () => {
    const buf = new StreamRenderBuffer({ maxBytesPerFrame: 64 });
    const frames: RenderFrame[] = [];
    buf.onFrame = (f) => frames.push(f);

    const emojis = '😀🎉🚀🌟💡';
    const s = emojis.repeat(10);

    buf.push(s);
    await buf.flush(true);

    const allDelta = frames.map((f) => f.delta).join('');
    expect(allDelta).toBe(s);
    expect(loneSurrogates(allDelta)).toBe(0);
  });
});

// ──────────────────────────────────────────────
describe('帧间隔 ≥ frameBudget', () => {
  it('非 force 时 budget 耗尽后停止当前帧', async () => {
    // 每调用一次 performance.now() 推进 20ms，超过 frameBudgetMs=10
    let perfCalls = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      perfCalls++;
      return perfCalls * 20;
    });

    const buf = new StreamRenderBuffer({
      maxBytesPerFrame: 10_000,
      frameBudgetMs: 10,
    });
    const frames: RenderFrame[] = [];
    buf.onFrame = (f) => frames.push(f);

    buf.push('chunk1');
    buf.push('chunk2');
    buf.push('chunk3');

    // 每次 flush(false) 的时间检查都在 i=0 后触发，每帧只处理 1 个 chunk
    await buf.flush(false);
    await buf.flush(false);
    await buf.flush(true);

    expect(frames.length).toBeGreaterThanOrEqual(2);
    const allDelta = frames.map((f) => f.delta).join('');
    expect(allDelta).toBe('chunk1chunk2chunk3');
  });

  it('force 时无视 frameBudget', async () => {
    let perfCalls = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      perfCalls++;
      return perfCalls * 20;
    });

    const buf = new StreamRenderBuffer({
      maxBytesPerFrame: 10_000,
      frameBudgetMs: 1,
    });
    const frames: RenderFrame[] = [];
    buf.onFrame = (f) => frames.push(f);

    buf.push('x'.repeat(100));
    await buf.flush(true);

    expect(frames).toHaveLength(1);
    expect(frames[0]!.delta.length).toBe(100);
  });
});

// ──────────────────────────────────────────────
describe('S3 帧预算超限计数（6ms/8192B 预算热点）', () => {
  it('非 force 单帧耗时超 frameBudgetMs 时计数 + 条件告警', async () => {
    // 慢时钟 mock：每调用 performance.now() 推进 20ms > frameBudgetMs=6
    let perfCalls = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      perfCalls++;
      return perfCalls * 20;
    });
    // LoggerService 在非 dev（NODE_ENV=test）走 console.log(JSON)，
    // dev 才走 console.warn——两条出口都 spy，避免环境耦合假阴性。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const buf = new StreamRenderBuffer({
      maxBytesPerFrame: 10_000,
      frameBudgetMs: 6,
    });
    const frames: RenderFrame[] = [];
    buf.onFrame = (f) => frames.push(f);

    buf.push('chunk1');
    buf.push('chunk2');
    await buf.flush(false);

    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(buf.frameOverruns()).toBeGreaterThanOrEqual(1);
    expect(
      warnSpy.mock.calls.length + logSpy.mock.calls.length
    ).toBeGreaterThanOrEqual(1);
  });

  it('force 帧不计超限不告警（终态路径豁免）', async () => {
    let perfCalls = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      perfCalls++;
      return perfCalls * 20;
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const buf = new StreamRenderBuffer({
      maxBytesPerFrame: 10_000,
      frameBudgetMs: 6,
    });
    buf.onFrame = () => {};
    buf.push('x'.repeat(100));
    await buf.flush(true);

    expect(buf.frameOverruns()).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('常态快速帧不计数不告警', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const buf = new StreamRenderBuffer();
    buf.onFrame = () => {};
    buf.push('hello world');
    await buf.flush(false);

    expect(buf.frameOverruns()).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────
describe('hasEmittedFinal 终态单次派发与空残余补偿', () => {
  it('空残余时 push("", true) 自动补偿单次 isFinal 帧', () => {
    const buf = new StreamRenderBuffer();
    const frames: RenderFrame[] = [];
    buf.onFrame = (f) => frames.push(f);

    buf.push('', true);

    expect(frames).toHaveLength(1);
    expect(frames[0]!.isFinal).toBe(true);
    expect(frames[0]!.delta).toBe('');
    expect(frames[0]!.full).toBe('');
  });

  it('多次 flush 或多次空 final push 绝不重复派发 isFinal 帧', () => {
    const buf = new StreamRenderBuffer();
    const finalFrames: RenderFrame[] = [];
    buf.onFrame = (f) => {
      if (f.isFinal) finalFrames.push(f);
    };

    buf.push('hello', true);
    buf.flush(true);
    buf.flush(true);
    buf.push('', true);
    buf.flush(true);

    expect(finalFrames).toHaveLength(1);
    expect(finalFrames[0]!.full).toBe('hello');
  });

  it('分帧流式最后一帧恰好携带 isFinal: true', () => {
    const buf = new StreamRenderBuffer({ maxBytesPerFrame: 64 });
    const frames: RenderFrame[] = [];
    buf.onFrame = (f) => frames.push(f);

    buf.push('a'.repeat(100), true);
    buf.flush(false);
    buf.flush(true);

    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames[0]!.isFinal).toBe(false);
    expect(frames[frames.length - 1]!.isFinal).toBe(true);
    const finalCount = frames.filter((f) => f.isFinal).length;
    expect(finalCount).toBe(1);
  });
});

// ──────────────────────────────────────────────
describe('Unicode Grapheme 簇边界安全截断 (Intl.Segmenter)', () => {
  it('safeGraphemeCutPosition 对复杂 ZWJ 表情序列整体保留不切断', () => {
    // 👩‍💻 = \uD83D\uDC69\u200D\uD83D\uDCBB (woman technologist, UTF-16 len=5, 1 grapheme)
    const text = 'code: 👩‍💻 rocks';
    // 'code: ' is len 6. 👩‍💻 starts at index 6, ends at index 11.
    // Cut at maxLen 7, 8, 9, 10 should all return 6 (the start of the ZWJ grapheme)
    expect(safeGraphemeCutPosition(text, 7)).toBe(6);
    expect(safeGraphemeCutPosition(text, 8)).toBe(6);
    expect(safeGraphemeCutPosition(text, 10)).toBe(6);
    expect(safeGraphemeCutPosition(text, 11)).toBe(11);
  });

  it('safeGraphemeCutPosition 对国旗与组合字符安全截断', () => {
    // 🇺🇸 = \uD83C\uDDFA\uD83C\uDDF8 (Regional indicator symbols, len=4, 1 grapheme)
    const text = 'flag 🇺🇸 here';
    // 'flag ' is len 5. 🇺🇸 spans [5, 9).
    expect(safeGraphemeCutPosition(text, 6)).toBe(5);
    expect(safeGraphemeCutPosition(text, 8)).toBe(5);
    expect(safeGraphemeCutPosition(text, 9)).toBe(9);
  });

  it('flushFrame 在 ZWJ 表情边界安全分帧', () => {
    // 👩‍💻 = 5 chars
    const text = 'hello 👩‍💻 world';
    // maxBytes = 8 ('hello ' = 6, 6 + 5 = 11 > 8)
    const result = flushFrame([text], 8, performance.now() + 1000, false);
    expect(result.batch).toEqual(['hello ']);
    expect(result.remaining).toEqual(['👩‍💻 world']);
  });
});

// ──────────────────────────────────────────────
describe('默认 maxBytesPerFrame 契约（D2 收敛回归）', () => {
  // 契约锚点：当前默认值 1024（StreamRenderBuffer 构造函数私有字段）。
  // 默认值有意变更时同步更新本常量——测试锁的是「有界默认帧上限」行为本身。
  const DEFAULT_MAX_BYTES = 1024;

  it('默认构造：超过默认上限的大单 chunk 必须分帧，每帧 ≤ 默认上限', () => {
    const buf = new StreamRenderBuffer();
    const frames: RenderFrame[] = [];
    buf.onFrame = (f) => frames.push(f);

    const big = 'a'.repeat(DEFAULT_MAX_BYTES * 2 + 100);
    buf.push(big);
    // rAF 在测试环境为 stub → 手动循环非 force 刷完
    while (buf.bufferedLength() > 0) {
      buf.flush(false);
    }

    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) {
      expect(f.delta.length).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    }
    const allDelta = frames.map((f) => f.delta).join('');
    expect(allDelta).toBe(big);
    expect(buf.bufferedLength()).toBe(0);
  });

  it('默认构造：不超过默认上限的单 chunk 不拆分', () => {
    const buf = new StreamRenderBuffer();
    const frames: RenderFrame[] = [];
    buf.onFrame = (f) => frames.push(f);

    buf.push('x'.repeat(DEFAULT_MAX_BYTES));
    buf.flush(false);

    expect(frames).toHaveLength(1);
    expect(frames[0]!.delta).toBe('x'.repeat(DEFAULT_MAX_BYTES));
  });

  it('显式 maxBytesPerFrame 覆盖默认：构造 options 决定帧上限', () => {
    // 显式更小上限 → 分帧边界跟随 options，而非默认 8192
    const buf = new StreamRenderBuffer({ maxBytesPerFrame: 100 });
    const frames: RenderFrame[] = [];
    buf.onFrame = (f) => frames.push(f);

    const text = 'b'.repeat(300);
    buf.push(text);
    while (buf.bufferedLength() > 0) {
      buf.flush(false);
    }

    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) {
      expect(f.delta.length).toBeLessThanOrEqual(100);
    }
    expect(frames.map((f) => f.delta).join('')).toBe(text);
  });
});

// ──────────────────────────────────────────────
describe('flushFinal 小残余同步刷完不丢字（D2 收敛回归）', () => {
  it('残余 ≤ 2×maxBytesPerFrame：单帧同步收口，全文无损且 isFinal=true', () => {
    const buf = new StreamRenderBuffer({ maxBytesPerFrame: 64 });
    const frames: RenderFrame[] = [];
    buf.onFrame = (f) => frames.push(f);

    // 残余 100 ≤ 2×64=128 → 同步 force 单帧
    const text = 'hello stream 收口不丢字'.repeat(4);
    expect(text.length).toBeLessThanOrEqual(128);
    buf.push(text);
    buf.flushFinal();

    expect(frames).toHaveLength(1);
    expect(frames[0]!.delta).toBe(text);
    expect(frames[0]!.full).toBe(text);
    expect(frames[0]!.isFinal).toBe(true);
    expect(buf.bufferedLength()).toBe(0);
  });

  it('非 force 预刷后小残余经 flushFinal 收口，拼接 = 全文不丢字', () => {
    const buf = new StreamRenderBuffer({ maxBytesPerFrame: 64 });
    const frames: RenderFrame[] = [];
    buf.onFrame = (f) => frames.push(f);

    const partA = 'a'.repeat(60);
    const partB = 'b'.repeat(40); // 残余 40 ≤ 128
    buf.push(partA);
    buf.push(partB);
    buf.flush(false); // 首帧取 partA（60 ≤ 64，partB 会超限）

    buf.flushFinal(); // 小残余同步收口

    const allDelta = frames.map((f) => f.delta).join('');
    expect(allDelta).toBe(partA + partB);
    expect(buf.bufferedLength()).toBe(0);
    const finalFrames = frames.filter((f) => f.isFinal);
    expect(finalFrames).toHaveLength(1);
    expect(finalFrames[0]!).toBe(frames[frames.length - 1]);
    expect(finalFrames[0]!.full).toBe(partA + partB);
  });

  it('默认上限下 flushFinal 小残余同样同步无损', () => {
    const buf = new StreamRenderBuffer();
    const frames: RenderFrame[] = [];
    buf.onFrame = (f) => frames.push(f);

    const text = '默认帧上限下的小残余同步收口验证'.repeat(10);
    // ≤ 2×DEFAULT_MAX_BYTES → 同步路径
    expect(text.length).toBeLessThanOrEqual(2 * 1024);
    buf.push(text);
    buf.flushFinal();

    expect(frames).toHaveLength(1);
    expect(frames[0]!.full).toBe(text);
    expect(frames[0]!.isFinal).toBe(true);
  });
});
