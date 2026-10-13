// @vitest-environment jsdom
/**
 * Stage 04: WorkerPool 三级级联 Tier 1 物理强杀总线与超时硬杀原地重生单元测试。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Priority, type WorkerResponse } from './types';

interface FakeWorkerInstance {
  url: string;
  terminated: boolean;
  postMessage: ReturnType<typeof vi.fn>;
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((err: unknown) => void) | null;
  terminate: () => void;
}

const workerInstances: FakeWorkerInstance[] = [];

class FakeWorker implements FakeWorkerInstance {
  terminated = false;
  postMessage = vi.fn();
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;

  constructor(public url: string) {
    workerInstances.push(this);
  }

  terminate(): void {
    this.terminated = true;
  }
}

vi.stubGlobal('Worker', FakeWorker);

import { WorkerPool, type WorkerEntry } from './worker-pool';
import {
  _sealedHighlightCache,
  appendChunkToCodeBlock,
  clearSealedHighlightCache,
  evictSealedHighlightCacheBySession,
  getSealedHighlightCache,
  makeSealedHighlightCacheKey,
  setSealedHighlightCache,
  StreamingCodeHighlighter,
} from '../api/streamingCodeHighlighter';

describe('WorkerPool Stage 04 Tier 1 物理强杀与超时重生', () => {
  beforeEach(() => {
    workerInstances.length = 0;
    clearSealedHighlightCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('[MD-A03] 会话销毁时繁忙 Worker 线程被物理 terminate 且新实例原地补齐', async () => {
    const pool = new WorkerPool({ renderWorkers: 2, minimal: true });

    const abortController = new AbortController();
    const taskPromise = pool.schedule(
      'render',
      'markdown.render',
      { raw: 'huge-markdown-source' },
      Priority.High,
      { signal: abortController.signal, sessionId: 'session-alpha' }
    );

    const entries = (pool as unknown as { entries: WorkerEntry[] }).entries;
    const busyEntry = entries[0]!;
    expect(busyEntry.busy).toBe(true);
    expect(busyEntry.currentSessionId).toBe('session-alpha');

    const busyWorker = busyEntry.worker;
    const terminateSpy = vi.spyOn(busyWorker, 'terminate');

    // 触发三级级联取消总线 Tier 1 物理强杀
    pool.cancelBySession('session-alpha');

    // 1. 验证正在执行的物理 Worker 线程被强制 terminate 杀死
    expect(terminateSpy).toHaveBeenCalledTimes(1);

    // 2. 验证任务 Promise 被正确以 AbortError 拒绝
    await expect(taskPromise).rejects.toThrow(/cancelled/i);

    // 3. 验证 WorkerPool 实例数依然保持恒定容量（2 个），新实例已就绪且空闲
    expect(entries.length).toBe(2);
    expect(entries.every((e) => !e.busy && e.currentSessionId === null)).toBe(
      true
    );

    pool.dispose();
  });

  it('cancelBySession 同时剔除队列中同会话排队任务，并立即调度其他会话任务', async () => {
    const pool = new WorkerPool({
      renderWorkers: 1,
      taskTimeoutMs: 0,
      minimal: true,
    });

    // 任务 1：占用唯一 Worker（session-alpha）
    const runningAlpha = pool.schedule(
      'render',
      'markdown.render',
      { raw: 'alpha-1' },
      Priority.Normal,
      { sessionId: 'session-alpha' }
    );

    // 任务 2：进入队列排队（session-alpha）
    const queuedAlpha = pool.schedule(
      'render',
      'markdown.render',
      { raw: 'alpha-2' },
      Priority.Normal,
      { sessionId: 'session-alpha' }
    );

    // 任务 3：进入队列排队（session-beta，不应受影响）
    const queuedBeta = pool.schedule<string>(
      'render',
      'markdown.render',
      { raw: 'beta-1' },
      Priority.Normal,
      { sessionId: 'session-beta' }
    );

    expect(pool.getMetrics().queuedTasks).toBe(2);

    // 强杀 session-alpha
    pool.cancelBySession('session-alpha');

    await expect(runningAlpha).rejects.toThrow(/cancelled/i);
    await expect(queuedAlpha).rejects.toThrow(/cancelled/i);

    // 新补建的 Worker 应立即接管并派发 session-beta 的任务
    const entries = (pool as unknown as { entries: WorkerEntry[] }).entries;
    expect(entries.length).toBe(1);
    expect(entries[0]!.busy).toBe(true);
    expect(entries[0]!.currentSessionId).toBe('session-beta');

    // 模拟新 Worker 完成任务返回
    const activeTaskId = entries[0]!.currentTaskId!;
    const activeFakeWorker = entries[0]!
      .worker as unknown as FakeWorkerInstance;
    activeFakeWorker.onmessage?.({
      data: {
        id: activeTaskId,
        type: 'success',
        payload: '<p>beta-1</p>',
      },
    } as MessageEvent<WorkerResponse>);

    await expect(queuedBeta).resolves.toBe('<p>beta-1</p>');
    expect(entries[0]!.busy).toBe(false);
    expect(entries[0]!.currentSessionId).toBeNull();

    pool.dispose();
  });

  it('[MD-A04] 任务超时后执行物理 terminate 强杀并原地补建新实例，而非仅清除 busy 标记', async () => {
    vi.useFakeTimers();
    const pool = new WorkerPool({
      renderWorkers: 1,
      taskTimeoutMs: 200,
      minimal: true,
    });

    const taskPromise = pool.schedule(
      'render',
      'markdown.heavy-ast',
      { raw: 'infinite-loop' },
      Priority.Normal,
      { sessionId: 'session-timeout' }
    );

    const entries = (pool as unknown as { entries: WorkerEntry[] }).entries;
    const stalledWorker = entries[0]!.worker;
    const terminateSpy = vi.spyOn(stalledWorker, 'terminate');

    // 快进时间触发超时
    vi.advanceTimersByTime(250);

    // 验证物理强杀被触发且新实例已替换就绪
    expect(terminateSpy).toHaveBeenCalledTimes(1);
    await expect(taskPromise).rejects.toThrow(/timed out/i);
    expect(entries.length).toBe(1);
    expect(entries[0]!.worker).not.toBe(stalledWorker);
    expect(entries[0]!.busy).toBe(false);
    expect(entries[0]!.currentSessionId).toBeNull();

    pool.dispose();
  });
});

describe('StreamingCodeHighlighter & _sealedHighlightCache 单轨高亮与快照缓存', () => {
  beforeEach(() => {
    clearSealedHighlightCache();
  });

  it('未封口态返回纯转义文本，封口态执行完整多行高亮并写入 _sealedHighlightCache', () => {
    const cacheKey = makeSealedHighlightCacheKey('sess-1', 'msg-1', 1);
    const hl = new StreamingCodeHighlighter('typescript', cacheKey);

    hl.appendChunk('/* multi\nline */\nconst x = 1 < 2;');
    expect(hl.getAccumulatedCode()).toContain('const x = 1 < 2;');

    // 未封口态：仅转义，不写入封口缓存
    const openHtml = hl.push(hl.getAccumulatedCode(), { isSealed: false });
    expect(openHtml).toContain('&lt;');
    expect(_sealedHighlightCache.has(cacheKey)).toBe(false);

    // 封口态：单轨整块高亮并写入 _sealedHighlightCache
    const sealedHtml = hl.seal();
    expect(sealedHtml).toBeTruthy();
    expect(getSealedHighlightCache(cacheKey)).toBe(sealedHtml);

    // 会话级联驱逐缓存
    setSealedHighlightCache(
      makeSealedHighlightCacheKey('sess-2', 'msg-1', 1),
      '<span>keep</span>'
    );
    expect(evictSealedHighlightCacheBySession('sess-1')).toBe(1);
    expect(getSealedHighlightCache(cacheKey)).toBeUndefined();
    expect(
      getSealedHighlightCache(makeSealedHighlightCacheKey('sess-2', 'msg-1', 1))
    ).toBe('<span>keep</span>');
  });

  it('appendChunkToCodeBlock 执行 O(1) 原生 TextNode.appendData 追加', () => {
    const codeEl = document.createElement('code');
    const textNode = document.createTextNode('const a = ');
    codeEl.appendChild(textNode);
    const accRef = { current: 'const a = ' };

    appendChunkToCodeBlock(codeEl, textNode, '42;\n', accRef);
    expect(accRef.current).toBe('const a = 42;\n');
    expect(textNode.data).toBe('const a = 42;\n');
  });
});
