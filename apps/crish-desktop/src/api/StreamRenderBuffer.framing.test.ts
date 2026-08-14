import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamRenderBuffer } from './StreamRenderBuffer';
import type { RenderFrame } from './StreamRenderBuffer';

/**
 * 注意：构造函数将 maxBytesPerFrame 钳位到 Math.max(64, value)，
 * 因此单元测试中使用的 maxBytesPerFrame 必须 ≥ 64。
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
describe('F5-05/F5-06：单块超限拆帧（死代码回归）', () => {
  it('超大单 delta（> maxBytesPerFrame）不得整块单帧输出，须按上限拆帧', async () => {
    // 旧实现 flushFrame 中「batch.length === 0 拆块」分支不可达：
    // 首块无条件 push（wouldExceed 仅对非空 batch 拦截）→ 10MB 级单 delta
    // 整块单帧输出，maxBytesPerFrame/frameBudgetMs 全部失效、长任务阻塞。
    const buf = new StreamRenderBuffer({ maxBytesPerFrame: 100 });
    const frames: RenderFrame[] = [];
    buf.onFrame = (f) => frames.push(f);

    buf.push('a'.repeat(5000));
    // 非 force 逐帧刷完（rAF 在测试环境为 stub，手动循环 flush）
    while (buf.bufferedLength() > 0) {
      await buf.flush(false);
    }

    const allDelta = frames.map((f) => f.delta).join('');
    expect(allDelta).toBe('a'.repeat(5000));
    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) {
      expect(f.delta.length).toBeLessThanOrEqual(100);
    }
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
describe('flushFinal 预算式收口（T2.1，08-detail 3.1）', () => {
  it('常态（≤2×maxBytesPerFrame）：单帧同步刷完且 isFinal=true', async () => {
    const buf = new StreamRenderBuffer({ maxBytesPerFrame: 64 });
    const frames: RenderFrame[] = [];
    buf.onFrame = (f) => frames.push(f);

    // 100 ≤ 2×64=128 → 单帧
    buf.push('x'.repeat(100));
    buf.flushFinal();

    expect(frames).toHaveLength(1);
    expect(frames[0]!.delta).toBe('x'.repeat(100));
    expect(frames[0]!.isFinal).toBe(true);
    expect(buf.bufferedLength()).toBe(0);
  });

  it('临界 2×maxBytesPerFrame 恰好单帧收口', async () => {
    const buf = new StreamRenderBuffer({ maxBytesPerFrame: 64 });
    const frames: RenderFrame[] = [];
    buf.onFrame = (f) => frames.push(f);

    buf.push('y'.repeat(128));
    buf.flushFinal();

    expect(frames).toHaveLength(1);
    expect(frames[0]!.delta).toBe('y'.repeat(128));
    expect(frames[0]!.isFinal).toBe(true);
  });

  it('大残余（64KB）：预算恒成立，isFinal 仅最后一帧，拼接 = 全文', async () => {
    const buf = new StreamRenderBuffer({ maxBytesPerFrame: 64 });
    const frames: RenderFrame[] = [];
    buf.onFrame = (f) => frames.push(f);

    buf.push('a'.repeat(64 * 1024));
    buf.flushFinal();
    // 大残余路径：flushFrame(false) 已同步出首帧，剩余经 rAF 调度
    //（测试环境 rAF 为 stub）→ 手动循环刷完
    while (buf.bufferedLength() > 0) {
      await buf.flush(false);
    }

    const allDelta = frames.map((f) => f.delta).join('');
    expect(allDelta).toBe('a'.repeat(64 * 1024));
    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) {
      expect(f.delta.length).toBeLessThanOrEqual(64);
    }
    // isFinal 仅最后一帧
    const finalFrames = frames.filter((f) => f.isFinal);
    expect(finalFrames).toHaveLength(1);
    expect(finalFrames[0]!).toBe(frames[frames.length - 1]);
    // 64KB 是 64 的整数倍 → 最后一帧恰好 64B（无残差）
    expect(frames[frames.length - 1]!.delta).toBe('a'.repeat(64));
  });

  it('无残余时 flushFinal 产出终态空帧（终态补偿）且后续幂等', () => {
    const buf = new StreamRenderBuffer({ maxBytesPerFrame: 64 });
    const frames: RenderFrame[] = [];
    buf.onFrame = (f) => frames.push(f);

    buf.flushFinal();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.isFinal).toBe(true);
    expect(frames[0]!.delta).toBe('');
    buf.flushFinal();
    expect(frames).toHaveLength(1);
  });

  it('flushFinal 后 push 不再接收（final 标记生效）', () => {
    const buf = new StreamRenderBuffer({ maxBytesPerFrame: 64 });
    const frames: RenderFrame[] = [];
    buf.onFrame = (f) => frames.push(f);

    buf.push('early');
    buf.flushFinal();
    buf.push('late');
    buf.flushFinal();

    expect(frames).toHaveLength(1);
    expect(frames[0]!.delta).toBe('early');
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
