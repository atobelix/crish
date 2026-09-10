// @vitest-environment jsdom
/**
 * useNoteTextPersistence & useNoteDocumentManager 并发保护单测
 * （audit-repair-202609 · DEF-NOTE-PERSIST-01/02/03/04/05）
 *
 * 覆盖重点：
 * 1. 【DEF-NOTE-PERSIST-01】flushBlockText 排队锁与 inFlight 互斥保护，杜绝 "ABA" 差量基准错位；
 * 2. 【DEF-NOTE-PERSIST-01】1500ms maxWait 刚性落盘机制，防止高频输入下防抖持续推迟导致饿死；
 * 3. 【DEF-NOTE-PERSIST-04】beforeunload 应急同步刷盘至 localStorage，抢救未落盘草稿；
 * 3b.【§6 写必可读回】挂载/打开时 loadEmergencyDraftSync 生产读回 + 叠字，防假绿；
 * 4. 【DEF-NOTE-PERSIST-05】多块混合编辑下的诚实保存状态机；
 * 5. 【DEF-NOTE-PERSIST-03】useNoteDocumentManager 切换文档时可靠等待，杜绝 500ms 强杀丢数据。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useNoteTextPersistence,
  PERSIST_DEBOUNCE_MS,
  PERSIST_MAX_WAIT_MS,
  loadEmergencyDraftSync,
  clearEmergencyDraftSync,
  saveEmergencyDraftSync,
  overlayEmergencyDraftTexts,
} from './useNoteTextPersistence';
import { useNoteDocumentManager } from './useNoteDocumentManager';
import { makeHydratedBlock } from './hydrateProjection';
import type { ApplyOpsAdapter, ApplyOpsOutcome } from '@crish/block-paper';

describe('useNoteTextPersistence · 并发保护与刚性落盘 (DEF-NOTE-PERSIST)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('DEF-NOTE-PERSIST-01: 并发调用 flushBlockText 时操作严格串行排队，杜绝 ABA 差量错位与文本重复', async () => {
    const opsHistory: Array<{ opsJson: string; intentId?: string }> = [];

    // 模拟有延迟的 applyOps 适配器
    let resolveFirstApply: ((outcome: ApplyOpsOutcome) => void) | null = null;
    let callCount = 0;

    const mockApplyOps: ApplyOpsAdapter = (opsJson, options) => {
      callCount++;
      opsHistory.push({ opsJson, intentId: options?.intentId });

      if (callCount === 1) {
        // 第一笔写入模拟异步等待
        return new Promise<ApplyOpsOutcome>((resolve) => {
          resolveFirstApply = resolve;
        });
      }
      return Promise.resolve({ ok: true });
    };

    const blocks = [
      makeHydratedBlock({ id: 'b1', flavour: 'paragraph', text: '', index: 0 }),
    ];

    const { result } = renderHook(() =>
      useNoteTextPersistence({
        docId: 'doc-concurrent',
        applyOpsProp: mockApplyOps,
        blocks,
      })
    );

    // 1. 用户键入 "A" 并立即回车确认
    act(() => {
      result.current.handleTextCommit('b1', 'A');
    });

    expect(callCount).toBe(1);
    expect(result.current.localSaveStatus).toBe('saving');

    // 此时第一笔写入处于 inFlight 状态，后端尚未返回
    // 2. 用户紧接着在同一块中键入 "B" 并回车确认（文本变为 "AB"）
    act(() => {
      result.current.handleTextCommit('b1', 'AB');
    });

    // 验证：由于 inFlight 互斥排队锁，第二笔写入绝不能并发抢跑！
    expect(callCount).toBe(1);

    // 3. 后端响应第一笔写入成功
    await act(async () => {
      resolveFirstApply?.({ ok: true });
      // 推进微任务让排队的第二笔执行
      await Promise.resolve();
    });

    // 验证：第二笔写入在前序完成后被自动排队调度
    expect(callCount).toBe(2);

    // 解析两笔写入生成的差量 op
    const op1 = JSON.parse(opsHistory[0].opsJson);
    const op2 = JSON.parse(opsHistory[1].opsJson);

    // 第一笔 op 应为在 0 插入 "A"
    expect(op1).toEqual([
      {
        op: 'text_edit',
        id: 'b1',
        start: 0,
        end: 0,
        insert: 'A',
      },
    ]);

    // 第二笔 op 必须以 "A" 为基准计算增量，即在 1 插入 "B"，绝对不能是在 0 插入 "AB"！
    expect(op2).toEqual([
      {
        op: 'text_edit',
        id: 'b1',
        start: 1,
        end: 1,
        insert: 'B',
      },
    ]);

    // 最终保存状态为 saved
    expect(result.current.localSaveStatus).toBe('saved');
  });

  it('DEF-NOTE-PERSIST-01: 1500ms maxWait 刚性落盘机制，防止持续击键下防抖饿死', async () => {
    let flushCount = 0;
    const appliedTexts: string[] = [];

    const mockApplyOps: ApplyOpsAdapter = (opsJson) => {
      flushCount++;
      const ops = JSON.parse(opsJson);
      appliedTexts.push(ops[0]?.insert ?? '');
      return Promise.resolve({ ok: true });
    };

    const blocks = [
      makeHydratedBlock({ id: 'b1', flavour: 'paragraph', text: '', index: 0 }),
    ];

    const { result } = renderHook(() =>
      useNoteTextPersistence({
        docId: 'doc-maxwait',
        applyOpsProp: mockApplyOps,
        blocks,
      })
    );

    // 模拟高频连续输入：每 200ms 输入一个字符（200ms < 400ms debounce 窗口）
    // 若没有 maxWait，连续输入会一直重置 400ms 定时器导致永远不落盘
    act(() => {
      result.current.handleBlockChange('b1', 'H'); // t=0
    });

    // 连续输入 7 次，每次间隔 200ms (t=200, 400, 600, 800, 1000, 1200, 1400)
    for (let i = 1; i <= 7; i++) {
      act(() => {
        vi.advanceTimersByTime(200);
      });
      act(() => {
        result.current.handleBlockChange('b1', 'Hello'.slice(0, i + 1));
      });
    }

    // t=1400ms 时，由于每次都在 200ms 内重置，尚未触发
    expect(flushCount).toBe(0);

    // 前进 100ms 到达 t=1500ms（刚好触达 PERSIST_MAX_WAIT_MS 刚性上限）
    await act(async () => {
      vi.advanceTimersByTime(100);
      await Promise.resolve();
    });

    // 刚性落盘被强制触发！
    expect(flushCount).toBe(1);
    expect(appliedTexts[0]).toBe('Hello');
  });

  it('DEF-NOTE-PERSIST-04: window beforeunload 应急同步抢救未落盘草稿至 localStorage', async () => {
    const mockApplyOps: ApplyOpsAdapter = () => Promise.resolve({ ok: true });
    const blocks = [
      makeHydratedBlock({ id: 'b1', flavour: 'paragraph', text: '', index: 0 }),
      makeHydratedBlock({ id: 'b2', flavour: 'paragraph', text: '', index: 1 }),
    ];

    const { result } = renderHook(() =>
      useNoteTextPersistence({
        docId: 'doc-emergency',
        applyOpsProp: mockApplyOps,
        blocks,
      })
    );

    // 用户在两块中输入内容但尚未触发 400ms 防抖
    act(() => {
      result.current.handleBlockChange('b1', '草稿第一段内容');
      result.current.handleBlockChange('b2', '草稿第二段内容');
    });

    // 此时尚未落盘
    expect(loadEmergencyDraftSync('doc-emergency')).toBeNull();

    // 模拟窗口关闭 / 刷新触发 beforeunload
    act(() => {
      window.dispatchEvent(new Event('beforeunload'));
    });

    // 同步抢救生效：localStorage 中已可靠写入未落盘草稿
    const rescued = loadEmergencyDraftSync('doc-emergency');
    expect(rescued).toEqual({
      b1: '草稿第一段内容',
      b2: '草稿第二段内容',
    });

    // 当异步冲刷执行完成后，应急草稿被安全自动清除
    await act(async () => {
      await Promise.resolve();
    });
    expect(loadEmergencyDraftSync('doc-emergency')).toBeNull();
  });

  it('DEF-NOTE-PERSIST-05: 多块并发编辑状态机诚实反映，禁止局部成功冒充全局 saved', async () => {
    let shouldFailB2 = true;

    const mockApplyOps: ApplyOpsAdapter = (opsJson) => {
      const ops = JSON.parse(opsJson);
      if (ops[0]?.id === 'b2' && shouldFailB2) {
        return Promise.resolve({ ok: false });
      }
      return Promise.resolve({ ok: true });
    };

    const blocks = [
      makeHydratedBlock({ id: 'b1', flavour: 'paragraph', text: '', index: 0 }),
      makeHydratedBlock({ id: 'b2', flavour: 'paragraph', text: '', index: 1 }),
    ];

    const { result } = renderHook(() =>
      useNoteTextPersistence({
        docId: 'doc-status',
        applyOpsProp: mockApplyOps,
        blocks,
      })
    );

    // 初始状态为 null
    expect(result.current.localSaveStatus).toBeNull();

    // 同时修改 b1 与 b2
    act(() => {
      result.current.handleBlockChange('b1', 'Block 1 text');
      result.current.handleBlockChange('b2', 'Block 2 text');
    });

    expect(result.current.localSaveStatus).toBe('saving');

    // 提交 b2（模拟失败）
    await act(async () => {
      await result.current.handleTextCommit('b2', 'Block 2 text');
    });

    // b2 失败，状态诚实置为 unsaved
    expect(result.current.localSaveStatus).toBe('unsaved');

    // 随后提交 b1（成功）
    await act(async () => {
      await result.current.handleTextCommit('b1', 'Block 1 text');
    });

    // 关键校验：b1 成功不能粗暴将全局状态覆盖为 saved！因为 b2 仍然 unsaved！
    expect(result.current.localSaveStatus).toBe('unsaved');

    // 修复 b2 再次提交
    shouldFailB2 = false;
    await act(async () => {
      await result.current.handleTextCommit('b2', 'Block 2 fixed');
    });

    // 全部块均成功后，才变为 saved
    expect(result.current.localSaveStatus).toBe('saved');
  });

  it('DEF-NOTE-PERSIST-03: useNoteDocumentManager 切换文档时可靠等待草稿刷盘（耗时 800ms > 500ms 绝不强行截断）', async () => {
    let flushFinished = false;

    // 模拟需要 800ms（超过既有 500ms 强杀线）的刷盘任务
    const slowFlushPendingDraft = () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          flushFinished = true;
          resolve();
        }, 800);
      });

    const { result } = renderHook(() =>
      useNoteDocumentManager({
        initialDocId: 'doc-alpha',
        flushPendingDraft: slowFlushPendingDraft,
      })
    );

    // 启动切换文档
    let switchPromise: Promise<void>;
    act(() => {
      switchPromise = result.current.switchDocument('doc-beta');
    });

    // 前进 500ms（旧版 500ms 赛马守卫会在此刻强制 kill 并切换）
    act(() => {
      vi.advanceTimersByTime(500);
    });

    // 验证：在 500ms 时，刷盘尚未完成，activeDocId 绝对不能被提前切换成 doc-beta！
    expect(flushFinished).toBe(false);
    expect(result.current.activeDocId).toBe('doc-alpha');

    // 前进至 800ms，让刷盘完整完成
    await act(async () => {
      vi.advanceTimersByTime(300);
      await switchPromise;
    });

    // 验证：刷盘已完整执行完毕，文档安全切换为 doc-beta，数据零丢失
    expect(flushFinished).toBe(true);
    expect(result.current.activeDocId).toBe('doc-beta');
  });
  it('§6 写必可读回: 挂载时生产调用 loadEmergencyDraftSync，差异草稿进入 emergencyDrafts 并可再落盘', async () => {
    const applied: string[] = [];
    const mockApplyOps: ApplyOpsAdapter = (opsJson) => {
      applied.push(opsJson);
      return Promise.resolve({ ok: true });
    };

    // 模拟上次 beforeunload 已写入、进程被杀后来不及异步冲刷
    saveEmergencyDraftSync('doc-rescue', {
      b1: '抢救后可见的正文',
      b2: '第二段抢救',
    });
    expect(loadEmergencyDraftSync('doc-rescue')).toEqual({
      b1: '抢救后可见的正文',
      b2: '第二段抢救',
    });

    const blocks = [
      makeHydratedBlock({ id: 'b1', flavour: 'paragraph', text: '旧盘正文', index: 0 }),
      makeHydratedBlock({ id: 'b2', flavour: 'paragraph', text: '', index: 1 }),
    ];

    const { result } = renderHook(() =>
      useNoteTextPersistence({
        docId: 'doc-rescue',
        applyOpsProp: mockApplyOps,
        blocks,
        hydrateReady: true,
      })
    );

    // 可读回：hook 暴露应急草稿供 UI 叠字
    expect(result.current.emergencyDrafts).toEqual({
      b1: '抢救后可见的正文',
      b2: '第二段抢救',
    });

    // 叠字纯函数：展示层看到抢救文本，权威 blocks 入参不变
    const overlaid = overlayEmergencyDraftTexts(blocks, result.current.emergencyDrafts);
    expect(overlaid[0].text).toBe('抢救后可见的正文');
    expect(overlaid[1].text).toBe('第二段抢救');
    expect(blocks[0].text).toBe('旧盘正文');

    // 推进 debounce → 差量落盘（旧盘 → 抢救文本）
    await act(async () => {
      vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(applied.length).toBeGreaterThanOrEqual(1);
    // 差量 op 可能拆分前缀/后缀；语义上 b1 从「旧盘正文」救回、b2 插入抢救段
    const parsed = applied.map((j) => JSON.parse(j));
    const b1ops = parsed.filter((ops) => ops[0]?.id === 'b1');
    const b2ops = parsed.filter((ops) => ops[0]?.id === 'b2');
    expect(b1ops.length).toBeGreaterThanOrEqual(1);
    expect(b2ops.length).toBeGreaterThanOrEqual(1);
    const b1insert = b1ops.map((ops) => ops[0]?.insert ?? '').join('');
    expect(b1insert).toContain('抢救后可见的');
    expect(JSON.stringify(b2ops)).toContain('第二段抢救');
  });

  it('§6 写必可读回: hydrateReady=false 时不读回，避免 loading 假绿', () => {
    saveEmergencyDraftSync('doc-loading', { b1: '不该在 loading 应用' });

    const blocks = [
      makeHydratedBlock({ id: 'b1', flavour: 'paragraph', text: '', index: 0 }),
    ];

    const { result, rerender } = renderHook(
      ({ ready }: { ready: boolean }) =>
        useNoteTextPersistence({
          docId: 'doc-loading',
          applyOpsProp: () => Promise.resolve({ ok: true }),
          blocks,
          hydrateReady: ready,
        }),
      { initialProps: { ready: false } }
    );

    expect(result.current.emergencyDrafts).toBeNull();

    rerender({ ready: true });
    expect(result.current.emergencyDrafts).toEqual({
      b1: '不该在 loading 应用',
    });
  });

  it('§6 写必可读回: 磁盘已与抢救一致时清除陈旧快照，不假叠字', () => {
    saveEmergencyDraftSync('doc-stale', { b1: '已落盘' });
    const blocks = [
      makeHydratedBlock({ id: 'b1', flavour: 'paragraph', text: '已落盘', index: 0 }),
    ];

    const { result } = renderHook(() =>
      useNoteTextPersistence({
        docId: 'doc-stale',
        applyOpsProp: () => Promise.resolve({ ok: true }),
        blocks,
        hydrateReady: true,
      })
    );

    expect(result.current.emergencyDrafts).toBeNull();
    expect(loadEmergencyDraftSync('doc-stale')).toBeNull();
  });

  it('overlayEmergencyDraftTexts: 无草稿保持引用；有草稿只改对应 text', () => {
    const blocks = [
      makeHydratedBlock({ id: 'a', flavour: 'paragraph', text: 'A', index: 0 }),
      makeHydratedBlock({ id: 'b', flavour: 'paragraph', text: 'B', index: 1 }),
    ];
    expect(overlayEmergencyDraftTexts(blocks, null)).toBe(blocks);
    expect(overlayEmergencyDraftTexts(blocks, {})).toBe(blocks);
    const out = overlayEmergencyDraftTexts(blocks, { b: 'B2' });
    expect(out[0].text).toBe('A');
    expect(out[1].text).toBe('B2');
    expect(blocks[1].text).toBe('B');
  });
});
