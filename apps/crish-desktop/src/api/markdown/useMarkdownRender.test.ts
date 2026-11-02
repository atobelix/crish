// @vitest-environment jsdom
/**
 * useStreamingMarkdownResult（活跃尾块流式渲染）测试。
 *
 * 覆盖点（R5 + 前缀有效落帧）：
 * - 轮询间隔随尾块长度分档拉长并封顶（streamPollIntervalMs）；
 * - 同等时长内，长尾块的 IPC 渲染次数显著少于短尾块；
 * - IPC 往返期间文本仅追加（快照是最新文本的前缀）时，快照结果直接
 *   落帧并立即追新，不再整帧丢弃；
 * - 文本被改写/回滚（非前缀分叉）时旧结果仍被丢弃，并立即以最新
 *   文本重试、最终落最新结果；
 * - 慢 IPC + 持续前移下无饥饿窗口、无千字级单帧倾泻，渲染尝试次数
 *   受 settle 次数上界约束；
 * - 文本未变时渲染失败置 failed。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  streamPollIntervalMs,
  useStreamingMarkdownResult,
} from './useMarkdownRender';
import { renderMarkdownStream } from '../rustCore';

vi.mock('../rustCore', () => ({
  renderMarkdownStream: vi.fn(),
}));

vi.mock('../markdownRenderScheduler', () => ({
  prewarmMarkdownResults: vi.fn(),
  requestMarkdownResult: vi.fn(async () => null),
}));

vi.mock('../markdownResultCache', () => ({
  getMarkdownResult: vi.fn(() => undefined),
}));

const mockStream = vi.mocked(renderMarkdownStream);

describe('streamPollIntervalMs', () => {
  it('随尾块长度分档拉长并封顶', () => {
    expect(streamPollIntervalMs(0)).toBe(33);
    expect(streamPollIntervalMs(2_000)).toBe(33);
    expect(streamPollIntervalMs(2_001)).toBe(50);
    expect(streamPollIntervalMs(8_000)).toBe(50);
    expect(streamPollIntervalMs(16_000)).toBe(80);
    expect(streamPollIntervalMs(32_000)).toBe(120);
    expect(streamPollIntervalMs(64_000)).toBe(200);
    expect(streamPollIntervalMs(128_000)).toBe(320);
    expect(streamPollIntervalMs(1_000_000)).toBe(500);
  });
});

describe('useStreamingMarkdownResult', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockStream.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('结果未过期时正常落帧', async () => {
    mockStream.mockImplementation(async () => ({
      html: '<p>ok</p>',
      truncated: false,
    }));
    const { result } = renderHook(() =>
      useStreamingMarkdownResult('hello', 'chat')
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.html).toBe('<p>ok</p>');
    expect(result.current.failed).toBe(false);
  });

  it('文本未变时渲染失败置 failed', async () => {
    mockStream.mockImplementation(async () => null);
    const { result } = renderHook(() =>
      useStreamingMarkdownResult('hello', 'chat')
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.failed).toBe(true);
  });

  it('往返期间文本仅追加（前缀）时落快照帧并立即追新', async () => {
    let resolveFirst:
      ((value: { html: string; truncated: boolean } | null) => void) | null =
      null;
    mockStream
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockImplementation(async (source: string) => ({
        html: `<p>fresh:${source.length}</p>`,
        truncated: false,
      }));

    const { result, rerender } = renderHook(
      ({ text }: { text: string }) => useStreamingMarkdownResult(text, 'chat'),
      { initialProps: { text: 'hello' } }
    );
    expect(mockStream).toHaveBeenCalledTimes(1);

    rerender({ text: 'hello world' });
    await act(async () => {
      resolveFirst?.({ html: '<p>snapshot:hello</p>', truncated: false });
    });
    // 'hello' 是 'hello world' 的前缀：快照帧是合法进度，直接落帧
    expect(result.current.html).toBe('<p>snapshot:hello</p>');

    // settle 后立即（0ms）以最新文本追新，不等常规轮询间隔
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockStream).toHaveBeenCalledTimes(2);
    expect(mockStream.mock.calls[1]?.[0]).toBe('hello world');
    expect(result.current.html).toBe('<p>fresh:11</p>');
  });

  it('往返期间文本被改写（非前缀分叉）时丢弃旧结果并立即重试', async () => {
    let resolveFirst:
      ((value: { html: string; truncated: boolean } | null) => void) | null =
      null;
    mockStream
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockImplementation(async (source: string) => ({
        html: `<p>fresh:${source}</p>`,
        truncated: false,
      }));

    const { result, rerender } = renderHook(
      ({ text }: { text: string }) => useStreamingMarkdownResult(text, 'chat'),
      { initialProps: { text: 'hello' } }
    );
    expect(mockStream).toHaveBeenCalledTimes(1);

    rerender({ text: 'goodbye' });
    await act(async () => {
      resolveFirst?.({ html: '<p>stale</p>', truncated: false });
    });
    // 'goodbye' 不以 'hello' 为前缀：旧结果不是新文本的合法进度，丢弃
    expect(result.current.html).not.toBe('<p>stale</p>');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockStream).toHaveBeenCalledTimes(2);
    expect(mockStream.mock.calls[1]?.[0]).toBe('goodbye');
    expect(result.current.html).toBe('<p>fresh:goodbye</p>');
  });

  it('往返期间文本回滚（快照不再是前缀）时丢弃旧结果', async () => {
    let resolveFirst:
      ((value: { html: string; truncated: boolean } | null) => void) | null =
      null;
    mockStream
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockImplementation(async (source: string) => ({
        html: `<p>fresh:${source}</p>`,
        truncated: false,
      }));

    const { result, rerender } = renderHook(
      ({ text }: { text: string }) => useStreamingMarkdownResult(text, 'chat'),
      { initialProps: { text: 'hello world' } }
    );
    expect(mockStream).toHaveBeenCalledTimes(1);

    rerender({ text: 'hello' });
    await act(async () => {
      resolveFirst?.({ html: '<p>stale</p>', truncated: false });
    });
    // 最新文本 'hello' 不以快照 'hello world' 为前缀：丢弃
    expect(result.current.html).not.toBe('<p>stale</p>');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockStream).toHaveBeenCalledTimes(2);
    expect(mockStream.mock.calls[1]?.[0]).toBe('hello');
    expect(result.current.html).toBe('<p>fresh:hello</p>');
  });

  it('慢 IPC + 持续前移下无饥饿窗口、无大额单帧倾泻、尝试次数有上界', async () => {
    const LATENCY = 50; // IPC 往返（fake timer 驱动）
    const STEP = 10; // 文本每 10ms 前移一次，快于往返
    const CHUNK = 8; // 每次前移 8 字符
    const STEPS = 400; // 到达期共 3990ms、总长 3200 字符
    const full = 'a'.repeat(CHUNK * STEPS);
    mockStream.mockImplementation(
      (source: string) =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve({ html: `<p>${source}</p>`, truncated: false }),
            LATENCY
          );
        })
    );

    const { result, rerender } = renderHook(
      ({ text }: { text: string }) => useStreamingMarkdownResult(text, 'chat'),
      { initialProps: { text: full.slice(0, CHUNK) } }
    );

    // 记录已画帧序列（时刻, 已画长度）；纯 'a' 文本下长度即前缀进度。
    const landings: { t: number; len: number }[] = [];
    let lastLen = -1;
    let now = 0;
    const observe = () => {
      const html = result.current.html;
      const len = html ? html.length - '<p></p>'.length : 0;
      if (len !== lastLen) {
        landings.push({ t: now, len });
        lastLen = len;
      }
    };
    observe();

    for (let i = 2; i <= STEPS; i += 1) {
      rerender({ text: full.slice(0, CHUNK * i) });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STEP);
      });
      now += STEP;
      observe();
    }
    const arrivalEnd = now;

    for (let d = 0; d < 100 && lastLen !== full.length; d += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      now += 100;
      observe();
    }

    const painted = landings.filter((l) => l.len > 0);
    const gaps = painted.slice(1).map((l, i) => l.t - (painted[i]?.t ?? 0));
    const jumps = painted
      .slice(1)
      .map((l, i) => l.len - (painted[i]?.len ?? 0));

    // 已画帧构成单调前缀推进（长度严格递增）
    expect(jumps.every((j) => j > 0)).toBe(true);
    // 到达期内持续落帧，无整帧饥饿窗口：相邻落帧间隔至多一个 IPC
    // 往返 + 追新调度在假时钟下的量化延迟（实测稳定 110ms；旧语义
    // 下整个到达期零落帧、唯一间隔为全程 4090ms）。
    expect(
      painted.filter((l) => l.t <= arrivalEnd).length
    ).toBeGreaterThanOrEqual(40);
    expect(Math.max(0, ...gaps)).toBeLessThanOrEqual(LATENCY + 70);
    // 落帧层面的单帧增量至多「一个往返内到达的字符数」量级，
    // 远离千字级倾泻（旧语义下收敛帧一次吐出全部 3200 字符积压）。
    expect(Math.max(0, ...jumps)).toBeLessThanOrEqual(
      CHUNK * Math.ceil(LATENCY / STEP) + CHUNK * 3
    );
    // 尝试次数有上界：至多一帧在飞 + settle 驱动，≤ 到达期/settle
    // 间隔 + 收尾追新（旧语义下尝试次数相近，但全部作废）。
    expect(mockStream.mock.calls.length).toBeLessThanOrEqual(
      Math.ceil((STEPS * STEP) / LATENCY) + 2
    );
    expect(mockStream.mock.calls.length).toBeGreaterThanOrEqual(40);
    // 终态落帧与静态渲染一致（同一文本的渲染结果）
    expect(result.current.html).toBe(`<p>${full}</p>`);
  });

  it('同等时长内长尾块的 IPC 次数显著少于短尾块', async () => {
    mockStream.mockImplementation(async (source: string) => ({
      html: `<p>${source.length}</p>`,
      truncated: false,
    }));

    const short = renderHook(
      ({ text }: { text: string }) => useStreamingMarkdownResult(text, 'chat'),
      { initialProps: { text: 'a' } }
    );
    for (let i = 0; i < 10; i += 1) {
      short.rerender({ text: 'a'.repeat(i + 2) });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(33);
      });
    }
    const shortCalls = mockStream.mock.calls.length;
    short.unmount();

    mockStream.mockClear();
    const longBase = 'x'.repeat(40_000);
    const long = renderHook(
      ({ text }: { text: string }) => useStreamingMarkdownResult(text, 'chat'),
      { initialProps: { text: longBase } }
    );
    for (let i = 0; i < 10; i += 1) {
      long.rerender({ text: longBase + 'x'.repeat(i + 1) });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(33);
      });
    }
    const longCalls = mockStream.mock.calls.length;
    long.unmount();

    expect(shortCalls).toBeGreaterThanOrEqual(8);
    expect(longCalls).toBeLessThanOrEqual(4);
    expect(longCalls).toBeLessThan(shortCalls);
  });
});
