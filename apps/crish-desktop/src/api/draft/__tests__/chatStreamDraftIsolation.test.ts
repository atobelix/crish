// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/api/draft/__tests__/chatStreamDraftIsolation.test.ts
 * Wave 3 全链路集成测试：INT-01 输入态保护屏障、跨会话草稿隔离与 sessionScheduleBadgeStore 协同验证
 *
 * 覆盖三大核心测试组（参考 `03-阶段三-目标会话绑定与对话内自动化定时任务能力最终方案.md` §5.1 / §5.3 / §7 / §8.2）：
 * - 测试组 1（INT-01 高频流式推送下的草稿与焦点零干扰屏障）
 * - 测试组 2（跨会话草稿隔离）
 * - 测试组 3（`sessionScheduleBadgeStore` 与组件协同验证）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import {
  DRAFT_PERSIST_DEBOUNCE_MS,
  SessionDraftManager,
  TYPING_BARRIER_WINDOW_MS,
} from '../sessionDraftManager';
import {
  EMPTY_SESSION_SCHEDULES,
  sessionScheduleBadgeStore,
  syncFromWorkflows as syncScheduleBadgeStore,
  useSessionActiveScheduleCount,
  useSessionScheduleBadgeStore,
  useSessionSchedules,
  type WorkflowDef,
} from '../../../store/sessionScheduleBadgeStore';

const storeState = vi.hoisted(() => {
  const composerDrafts: Record<string, string> = {};
  const setComposerDraft = vi.fn((sessionId: string, draft: string) => {
    if (!draft) {
      delete composerDrafts[sessionId];
    } else {
      composerDrafts[sessionId] = draft;
    }
  });
  return { composerDrafts, setComposerDraft };
});

vi.mock('../../storeAccess', () => ({
  getSessionStoreState: () => ({ composerDrafts: storeState.composerDrafts }),
  setComposerDraft: storeState.setComposerDraft,
}));

describe('Wave 3 全链路集成测试 · INT-01 输入态保护屏障与会话定时任务协同', () => {
  let manager: SessionDraftManager;

  beforeEach(() => {
    manager = new SessionDraftManager();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T09:00:00.000Z'));
    Object.keys(storeState.composerDrafts).forEach(
      (key) => delete storeState.composerDrafts[key]
    );
    storeState.setComposerDraft.mockClear();
    useSessionScheduleBadgeStore.getState().clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  // =========================================================================
  // 测试组 1：INT-01 高频流式推送下的草稿与焦点零干扰屏障
  // =========================================================================
  describe('测试组 1：INT-01 高频流式推送下的草稿与焦点零干扰屏障', () => {
    it('用户在 sess-bound-1 连续输入草稿（含中文 IME 未完成组合与高频按键），并发触发 50 次后台定时任务流式活动时，草稿一字不差、撤销栈完好无损、焦点与屏障零干扰', () => {
      const sessionId = 'sess-bound-1';
      const notifySpy = vi.fn();
      manager.subscribe(notifySpy);

      // 1. 先准备一条历史撤销记录，验证高频流推送不会破坏既有撤销栈
      manager.setDraft(sessionId, '初始构思：检查 Rust workspace 编译状态');
      manager.injectSeed({
        targetSessionId: sessionId,
        content: '/schedule 每日巡检模板',
        mode: 'replace',
        metadata: { source: 'schedule_panel' },
      });
      expect(manager.hasUndo(sessionId)).toBe(true);
      notifySpy.mockClear();

      // 2. 挂载真实 textarea DOM 并聚焦，模拟用户正在输入框中进行中文 IME 组合与高频敲击
      const textarea = document.createElement('textarea');
      document.body.appendChild(textarea);
      textarea.focus();
      expect(document.activeElement).toBe(textarea);

      manager.setTypingActive(sessionId, true);
      expect(manager.isTypingBarrierActive(sessionId)).toBe(true);

      const typingSteps = [
        '请帮我分析当前分支的 ',
        '请帮我分析当前分支的 dingshi',
        '请帮我分析当前分支的 定时',
        '请帮我分析当前分支的 定时renwu',
        '请帮我分析当前分支的 定时任务触发链路与 steering_queue ',
        '请帮我分析当前分支的 定时任务触发链路与 steering_queue 消费隔离情况，特别是 shuru',
        '请帮我分析当前分支的 定时任务触发链路与 steering_queue 消费隔离情况，特别是 输入态保护屏障（INT-01）！',
      ];

      // 3. 交错执行用户高频输入与 50 次后台定时任务流式推送（chat:stream / workflow:run-*）
      for (let i = 0; i < 50; i++) {
        const stepIdx = Math.min(
          typingSteps.length - 1,
          Math.floor((i / 50) * typingSteps.length)
        );
        const currentInput = typingSteps[stepIdx]!;
        textarea.value = currentInput;
        textarea.setSelectionRange(currentInput.length, currentInput.length);
        manager.setDraft(sessionId, currentInput);

        // 模拟后台定时任务流式 delta / 状态更新到达
        const guard = manager.onBackgroundStreamActivity(sessionId, {
          source: i % 2 === 0 ? 'scheduled_task' : 'agent_stream',
          runId: `run-sched-cron-1-${i}`,
        });

        expect(guard.barrierActive).toBe(true);
        expect(guard.draftContent).toBe(currentInput);

        // 模拟时间微步推进（每轮 20ms，全程处于高频敲击状态）
        vi.advanceTimersByTime(20);
      }

      const finalExpectedDraft = typingSteps[typingSteps.length - 1]!;

      // 4. 断言：50 次并发流式活动后，草稿内容一字不差、DOM 焦点与光标未丢失、未触发外部覆盖通知
      expect(manager.getDraft(sessionId)).toBe(finalExpectedDraft);
      expect(document.activeElement).toBe(textarea);
      expect(textarea.selectionStart).toBe(finalExpectedDraft.length);
      expect(notifySpy).not.toHaveBeenCalled();

      // 5. 断言：既有撤销栈完好无损，可执行 undoDraft 恢复至最初构思
      expect(manager.hasUndo(sessionId)).toBe(true);
      const restored = manager.undoDraft(sessionId);
      expect(restored).toBe('初始构思：检查 Rust workspace 编译状态');

      document.body.removeChild(textarea);
    });

    it('isTypingBarrierActive 精确遵循焦点锁与 1500ms 时间窗，并在 safe_seed 注入时保护半截输入不丢失', () => {
      const sessionId = 'sess-bound-1';

      expect(manager.isTypingBarrierActive(sessionId)).toBe(false);

      // 1. 用户编辑草稿后，1500ms 窗口内屏障自动生效
      manager.setDraft(sessionId, '正在敲击半截文字...');
      expect(manager.isTypingBarrierActive(sessionId)).toBe(true);

      vi.advanceTimersByTime(TYPING_BARRIER_WINDOW_MS - 1);
      expect(manager.isTypingBarrierActive(sessionId)).toBe(true);

      // 超过 1500ms 且未持有焦点锁时，屏障自动解除
      vi.advanceTimersByTime(1);
      expect(manager.isTypingBarrierActive(sessionId)).toBe(false);

      // 2. 显式开启 IME/焦点锁时，即使超过时间窗屏障仍然保持激活
      manager.setTypingActive(sessionId, true);
      vi.advanceTimersByTime(5000);
      expect(manager.isTypingBarrierActive(sessionId)).toBe(true);

      // 3. 在打字保护屏障生效期间调用 injectSeed(safe_seed)，自动将半截文字压入撤销栈并安全追加保留
      const seedResult = manager.injectSeed({
        targetSessionId: sessionId,
        content: '/schedule 每天 09:00 巡检',
        mode: 'safe_seed',
        metadata: { source: 'schedule_panel' },
      });

      expect(seedResult.applied).toBe(true);
      expect(manager.getDraft(sessionId)).toBe(
        '正在敲击半截文字...\n\n/schedule 每天 09:00 巡检'
      );
      expect(manager.hasUndo(sessionId)).toBe(true);

      // 一键撤销可 100% 恢复至注入前的半截文字
      expect(manager.undoDraft(sessionId)).toBe('正在敲击半截文字...');

      // 释放焦点锁后屏障关闭
      manager.setTypingActive(sessionId, false);
      expect(manager.isTypingBarrierActive(sessionId)).toBe(false);
    });
  });

  // =========================================================================
  // 测试组 2：跨会话草稿隔离
  // =========================================================================
  describe('测试组 2：跨会话草稿隔离（sess-bound-1 与 sess-bound-2 互不污染）', () => {
    it('定时任务在 sess-bound-1 触发、流式输出与种子注入时，sess-bound-2 与 sess-bound-1 的草稿、撤销栈与打字屏障完全隔离', () => {
      const session1 = 'sess-bound-1';
      const session2 = 'sess-bound-2';

      manager.setDraft(session1, '会话 1 正在编写的草稿：排查 Cron 表达式解析');
      vi.advanceTimersByTime(DRAFT_PERSIST_DEBOUNCE_MS);
      manager.setDraft(
        session2,
        '会话 2 正在编写的草稿：重构 SessionRow 时钟徽标'
      );
      manager.setTypingActive(session2, true);

      // 推进防抖窗口使两个会话草稿均持久化到 Level 3 Store
      vi.advanceTimersByTime(DRAFT_PERSIST_DEBOUNCE_MS);
      expect(storeState.composerDrafts[session1]).toBe(
        '会话 1 正在编写的草稿：排查 Cron 表达式解析'
      );
      expect(storeState.composerDrafts[session2]).toBe(
        '会话 2 正在编写的草稿：重构 SessionRow 时钟徽标'
      );

      // 推进时间超过 1500ms，使得仅显式持有焦点锁的 session2 处于 typing barrier 激活态
      vi.advanceTimersByTime(TYPING_BARRIER_WINDOW_MS + 100);
      expect(manager.isTypingBarrierActive(session1)).toBe(false);
      expect(manager.isTypingBarrierActive(session2)).toBe(true);

      // 1. 定时任务在 sess-bound-1 密集触发流式输出
      for (let i = 0; i < 20; i++) {
        const res1 = manager.onBackgroundStreamActivity(session1, {
          source: 'scheduled_task',
          runId: `run-s1-${i}`,
        });
        expect(res1.draftContent).toBe(
          '会话 1 正在编写的草稿：排查 Cron 表达式解析'
        );
      }

      // 断言两个会话的草稿互不污染
      expect(manager.getDraft(session1)).toBe(
        '会话 1 正在编写的草稿：排查 Cron 表达式解析'
      );
      expect(manager.getDraft(session2)).toBe(
        '会话 2 正在编写的草稿：重构 SessionRow 时钟徽标'
      );

      // 2. 向 sess-bound-1 定向注入模板并执行撤销，验证 sess-bound-2 零受影响
      const notifications: string[] = [];
      manager.subscribe((payload) => {
        notifications.push(payload.sessionId);
      });

      manager.injectSeed({
        targetSessionId: session1,
        content: 'sess-bound-1 专属定时任务模板',
        mode: 'replace',
      });

      expect(manager.getDraft(session1)).toBe('sess-bound-1 专属定时任务模板');
      expect(manager.hasUndo(session1)).toBe(true);

      // sess-bound-2 的草稿、撤销栈与持久化状态纹丝不动
      expect(manager.getDraft(session2)).toBe(
        '会话 2 正在编写的草稿：重构 SessionRow 时钟徽标'
      );
      expect(manager.hasUndo(session2)).toBe(false);
      expect(storeState.composerDrafts[session2]).toBe(
        '会话 2 正在编写的草稿：重构 SessionRow 时钟徽标'
      );
      expect(notifications).toEqual([session1]);
    });
  });

  // =========================================================================
  // 测试组 3：sessionScheduleBadgeStore 与组件协同验证
  // =========================================================================
  describe('测试组 3：sessionScheduleBadgeStore 在新增/暂停/恢复/删除任务时的精确响应', () => {
    const wfBound1A: WorkflowDef = {
      id: 'wf-bound-1a',
      name: '每日构建检查',
      prompt: '运行 cargo check',
      enabled: true,
      targetSessionId: 'sess-bound-1',
      targetMode: 'current',
      schedule: { type: 'daily', time: '09:00' },
    };

    const wfBound1B: WorkflowDef = {
      id: 'wf-bound-1b',
      name: '每小时分支巡检',
      prompt: '检查 git status',
      enabled: true,
      targetSessionId: 'sess-bound-1',
      targetMode: 'current',
      schedule: { type: 'intervalMinutes', intervalMinutes: 60 },
    };

    const wfBound2: WorkflowDef = {
      id: 'wf-bound-2',
      name: '会话 2 专项监控',
      prompt: '运行 vitest',
      enabled: true,
      targetSessionId: 'sess-bound-2',
      targetMode: 'current',
      schedule: { type: 'cron', expression: '*/15 * * * *' },
    };

    const wfIsolated: WorkflowDef = {
      id: 'wf-isolated',
      name: '全局独立清理任务',
      prompt: '清理沙箱临时文件',
      enabled: true,
      targetSessionId: 'sess-bound-1',
      targetMode: 'isolated',
      schedule: { type: 'manual' },
    };

    it('新增、暂停、恢复、删除绑定会话的定时任务时，useSessionActiveScheduleCount 与 useSessionSchedules 精确响应且跨会话零重绘污染', () => {
      let renderCountSess2 = 0;

      const { result: countSess1 } = renderHook(() =>
        useSessionActiveScheduleCount('sess-bound-1')
      );
      const { result: schedulesSess1 } = renderHook(() =>
        useSessionSchedules('sess-bound-1')
      );
      const { result: countSess2 } = renderHook(() =>
        useSessionActiveScheduleCount('sess-bound-2')
      );
      const { result: schedulesSess2 } = renderHook(() => {
        renderCountSess2 += 1;
        return useSessionSchedules('sess-bound-2');
      });
      const { result: schedulesUnbound } = renderHook(() =>
        useSessionSchedules('sess-unbound')
      );

      // 初始空态断言
      expect(countSess1.current).toBe(0);
      expect(schedulesSess1.current).toBe(EMPTY_SESSION_SCHEDULES);
      expect(countSess2.current).toBe(0);
      expect(schedulesUnbound.current).toBe(EMPTY_SESSION_SCHEDULES);

      // 1. 【新增】：同步绑定到 sess-bound-1 (2 个启用) + sess-bound-2 (1 个启用) + 1 个 isolated 独立任务
      act(() => {
        syncScheduleBadgeStore([wfBound1A, wfBound1B, wfBound2, wfIsolated]);
      });

      expect(countSess1.current).toBe(2);
      expect(schedulesSess1.current.map((w) => w.id)).toEqual([
        'wf-bound-1a',
        'wf-bound-1b',
      ]);
      expect(countSess2.current).toBe(1);
      expect(schedulesSess2.current.map((w) => w.id)).toEqual(['wf-bound-2']);
      expect(sessionScheduleBadgeStore.getCount('sess-bound-1')).toBe(2);

      const sess2RefAfterAdd = schedulesSess2.current;
      const renderCountSess2AfterAdd = renderCountSess2;

      // 2. 【暂停】：暂停 sess-bound-1 的 wf-bound-1b（enabled: false）
      act(() => {
        syncScheduleBadgeStore([
          wfBound1A,
          { ...wfBound1B, enabled: false },
          wfBound2,
          wfIsolated,
        ]);
      });

      // sess-bound-1 活跃计数降为 1，但绑定的总任务列表仍包含 2 项
      expect(countSess1.current).toBe(1);
      expect(schedulesSess1.current).toHaveLength(2);
      expect(schedulesSess1.current[1]?.enabled).toBe(false);

      // sess-bound-2 引用严格不变且未触发额外重渲染
      expect(schedulesSess2.current).toBe(sess2RefAfterAdd);
      expect(renderCountSess2).toBe(renderCountSess2AfterAdd);

      // 3. 【恢复】：重新启用 wf-bound-1b（enabled: true）
      act(() => {
        syncScheduleBadgeStore([
          wfBound1A,
          { ...wfBound1B, enabled: true },
          wfBound2,
          wfIsolated,
        ]);
      });

      expect(countSess1.current).toBe(2);
      expect(schedulesSess1.current[1]?.enabled).toBe(true);
      expect(schedulesSess2.current).toBe(sess2RefAfterAdd);

      // 4. 【删除】：删除 wf-bound-1a，仅保留 wf-bound-1b
      act(() => {
        syncScheduleBadgeStore([wfBound1B, wfBound2]);
      });

      expect(countSess1.current).toBe(1);
      expect(schedulesSess1.current.map((w) => w.id)).toEqual(['wf-bound-1b']);
      expect(schedulesSess2.current).toBe(sess2RefAfterAdd);

      // 5. 【全部清空 sess-bound-1 的任务】：回退到 EMPTY_SESSION_SCHEDULES 常量引用
      act(() => {
        syncScheduleBadgeStore([wfBound2]);
      });

      expect(countSess1.current).toBe(0);
      expect(schedulesSess1.current).toBe(EMPTY_SESSION_SCHEDULES);
      expect(countSess2.current).toBe(1);
      expect(schedulesSess2.current).toBe(sess2RefAfterAdd);
    });
  });
});
