// @vitest-environment jsdom
/**
 * 定时任务全流程修复与能力升级战役（Scheduled Tasks Revamp）— 前端专项单元测试
 *
 * 覆盖五大核心验证维度：
 * 1. 行级乐观锁与 2000ms 防回弹窗口（`reconcileWorkflowListWithLocks` & `useWorkflowsState.reconcileWorkflows`）
 * 2. INT-06 `sessionScheduleBadgeStore` 原子 Selector 隔离与引用稳定性
 * 3. `WorkflowForm` 5 段式 Cron、全局默认工作区（`cwd = ""`）与目标会话绑定切换
 * 4. `WorkflowList` 行级独立并发锁（`togglingIds` / `triggeringIds`）与会话/工作区徽标展示
 * 5. `RunHistoryList` 历史孤儿 `interrupted` 状态渲染与防“蓝色运行中”误判
 */
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';

const listWorkflowsMock = vi.hoisted(() => vi.fn());
const listWorkflowRunsMock = vi.hoisted(() => vi.fn());
const updateWorkflowMock = vi.hoisted(() => vi.fn());
const createWorkflowMock = vi.hoisted(() => vi.fn());
const deleteWorkflowMock = vi.hoisted(() => vi.fn());
const triggerWorkflowMock = vi.hoisted(() => vi.fn());
const showToastMock = vi.hoisted(() => vi.fn());

vi.mock('../../../api/workflowApi', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../api/workflowApi')>();
  return {
    ...actual,
    listWorkflows: (...args: unknown[]) => listWorkflowsMock(...args),
    listWorkflowRuns: (...args: unknown[]) => listWorkflowRunsMock(...args),
    updateWorkflow: (...args: unknown[]) => updateWorkflowMock(...args),
    createWorkflow: (...args: unknown[]) => createWorkflowMock(...args),
    deleteWorkflow: (...args: unknown[]) => deleteWorkflowMock(...args),
    triggerWorkflow: (...args: unknown[]) => triggerWorkflowMock(...args),
  };
});

vi.mock('../../../api/workflow-api/workflowEvents', () => ({
  listenWorkflowEvents: vi.fn(async () => () => {}),
}));

vi.mock('../../../api/projectStore', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../api/projectStore')>();
  return {
    ...actual,
    listProjects: () => [
      { id: 'proj-1', name: 'Conex 核心仓', path: '/workspace/conex' },
      { id: 'proj-2', name: 'Crish 桌面端', path: '/workspace/crish' },
    ],
  };
});

vi.mock('../../../services/toast/ToastContext', () => ({
  useToast: () => ({
    showToast: (...args: unknown[]) => showToastMock(...args),
  }),
  toast: {
    show: (...args: unknown[]) => showToastMock(...args),
  },
}));

import {
  emptyWorkflowDraft,
  validateWorkflowDraft,
  buildScheduleFromDraft,
  type WorkflowDefinition,
  type WorkflowRunEntry,
  type WorkflowScheduleDraft,
} from '../../../api/workflowApi';
import { draftFromWorkflow } from '../../../api/workflow-api/workflowDraft';
import {
  EMPTY_SESSION_SCHEDULES,
  syncFromWorkflows,
  useSessionActiveScheduleCount,
  useSessionScheduleBadgeStore,
  useSessionSchedules,
  type WorkflowDef,
} from '../../../store/sessionScheduleBadgeStore';
import {
  OPTIMISTIC_LOCK_WINDOW_MS,
  reconcileWorkflowListWithLocks,
  useWorkflowsState,
  type OptimisticLockEntry,
} from '../useWorkflowsState';
import {
  WorkflowForm,
  type ExtendedWorkflowScheduleDraft,
} from '../WorkflowForm';
import { WorkflowList } from '../WorkflowList';
import { RunHistoryList } from '../RunHistoryList';
import styles from '../RunHistoryList.module.css';

describe('Scheduled Tasks Revamp — 前端五大核心维度专项单元测试', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useSessionScheduleBadgeStore.getState().clear();
    listWorkflowsMock.mockResolvedValue([]);
    listWorkflowRunsMock.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 维度 1：行级乐观锁与 2000ms 防回弹窗口 `reconcileWorkflows`
  // =========================================================================
  describe('维度 1：行级乐观锁与 2000ms 防回弹窗口 (reconcileWorkflows)', () => {
    const baseWf1: WorkflowDefinition = {
      id: 'wf-1',
      name: '每日构建巡检',
      prompt: '检查 CI 状态',
      enabled: true,
      schedule: { type: 'daily', time: '09:00', timezone: 'Asia/Shanghai' },
    };

    const baseWf2: WorkflowDefinition = {
      id: 'wf-2',
      name: '每小时同步',
      prompt: '同步远端分支',
      enabled: true,
      schedule: { type: 'intervalMinutes', intervalMinutes: 60 },
    };

    it('reconcileWorkflowListWithLocks 在 2000ms 保护期内抵御滞后旧快照，过期或对齐后自动释放锁', () => {
      const t0 = 1_700_000_000_000;
      const locks = new Map<string, OptimisticLockEntry>([
        ['wf-1', { enabled: false, until: t0 + OPTIMISTIC_LOCK_WINDOW_MS }],
      ]);

      // 1) 在 500ms 时收到滞后的旧快照（enabled 仍为 true），状态保持 false 不回弹
      const staleSnapshot: WorkflowDefinition[] = [
        { ...baseWf1, enabled: true },
        { ...baseWf2, enabled: true },
      ];
      const reconciledWithinWindow = reconcileWorkflowListWithLocks(
        staleSnapshot,
        locks,
        t0 + 500
      );
      expect(reconciledWithinWindow[0]?.enabled).toBe(false);
      expect(reconciledWithinWindow[1]?.enabled).toBe(true);
      expect(locks.has('wf-1')).toBe(true);

      // 2) 在 1200ms 时后端状态已对齐（enabled 为 false），锁立即清除且保持 false
      const alignedSnapshot: WorkflowDefinition[] = [
        { ...baseWf1, enabled: false },
        { ...baseWf2, enabled: true },
      ];
      const reconciledAligned = reconcileWorkflowListWithLocks(
        alignedSnapshot,
        locks,
        t0 + 1200
      );
      expect(reconciledAligned[0]?.enabled).toBe(false);
      expect(locks.has('wf-1')).toBe(false);

      // 3) 重新加锁后模拟超过 2000ms 窗口期（t0 + 2001ms），锁过期清除并以服务端最新值为准
      locks.set('wf-1', {
        enabled: false,
        until: t0 + OPTIMISTIC_LOCK_WINDOW_MS,
      });
      const reconciledExpired = reconcileWorkflowListWithLocks(
        [{ ...baseWf1, enabled: true }],
        locks,
        t0 + OPTIMISTIC_LOCK_WINDOW_MS + 1
      );
      expect(reconciledExpired[0]?.enabled).toBe(true);
      expect(locks.has('wf-1')).toBe(false);
    });

    it('useWorkflowsState.handleToggle 立即乐观翻转目标行，2000ms 窗口内 reconcileWorkflows 拦截旧快照回弹', async () => {
      listWorkflowsMock.mockResolvedValue([baseWf1, baseWf2]);

      let resolveUpdate!: (val: {
        ok: boolean;
        workflow?: WorkflowDefinition;
      }) => void;
      updateWorkflowMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveUpdate = resolve;
          })
      );

      const { result } = renderHook(() =>
        useWorkflowsState({ surface: 'settings' })
      );

      await waitFor(() => {
        expect(result.current.workflows.length).toBe(2);
      });
      expect(result.current.workflows[0]?.enabled).toBe(true);

      // 触发 wf-1 开关切换（true -> false）
      let togglePromise!: Promise<void>;
      act(() => {
        togglePromise = result.current.handleToggle(baseWf1);
      });

      // 0ms 乐观翻转：无需等待后端返回，wf-1 已变为 false，且仅锁定 wf-1
      expect(result.current.workflows[0]?.enabled).toBe(false);
      expect(result.current.togglingIds.has('wf-1')).toBe(true);
      expect(result.current.togglingIds.has('wf-2')).toBe(false);

      // 在 2000ms 乐观锁窗口期内收到滞后快照（wf-1 仍为 enabled: true）
      const reconciledDuringFlight = result.current.reconcileWorkflows([
        { ...baseWf1, enabled: true },
        { ...baseWf2, enabled: true },
      ]);
      expect(reconciledDuringFlight[0]?.enabled).toBe(false);

      // 完成后端更新响应
      await act(async () => {
        resolveUpdate({
          ok: true,
          workflow: { ...baseWf1, enabled: false },
        });
        await togglePromise;
      });

      expect(result.current.workflows[0]?.enabled).toBe(false);
      expect(result.current.togglingIds.has('wf-1')).toBe(false);

      // 即使更新刚完成后的 2000ms 窗口内再次收到乱序旧广播（enabled: true），依然不回弹
      const reconciledAfterSuccess = result.current.reconcileWorkflows([
        { ...baseWf1, enabled: true },
      ]);
      expect(reconciledAfterSuccess[0]?.enabled).toBe(false);
    });
  });

  // =========================================================================
  // 维度 2：INT-06 `sessionScheduleBadgeStore` 原子 Selector 隔离
  // =========================================================================
  describe('维度 2：INT-06 sessionScheduleBadgeStore 原子 Selector 隔离', () => {
    const wfSessionA1: WorkflowDef = {
      id: 'wf-a1',
      name: '会话A任务1（启用）',
      prompt: 'A1',
      enabled: true,
      targetSessionId: 'sess-A',
      schedule: { type: 'cron', expression: '*/5 * * * *' },
    };

    const wfSessionA2Paused: WorkflowDef = {
      id: 'wf-a2',
      name: '会话A任务2（暂停）',
      prompt: 'A2',
      enabled: false,
      targetSessionId: 'sess-A',
      schedule: { type: 'daily', time: '09:00' },
    };

    const wfSessionB1: WorkflowDef = {
      id: 'wf-b1',
      name: '会话B任务1（启用）',
      prompt: 'B1',
      enabled: true,
      targetSessionId: 'sess-B',
      schedule: { type: 'intervalMinutes', intervalMinutes: 30 },
    };

    const wfIsolated: WorkflowDef = {
      id: 'wf-iso',
      name: '独立后台任务',
      prompt: 'ISO',
      enabled: true,
      targetSessionId: '',
      executionMode: 'isolated_session',
      schedule: { type: 'manual' },
    };

    it('syncFromWorkflows 正确按 targetSessionId 归类，未绑定会话返回稳定 EMPTY_SESSION_SCHEDULES 引用', () => {
      syncFromWorkflows([
        wfSessionA1,
        wfSessionA2Paused,
        wfSessionB1,
        wfIsolated,
      ]);

      const state = useSessionScheduleBadgeStore.getState();
      expect(Object.keys(state.bySessionId).sort()).toEqual([
        'sess-A',
        'sess-B',
      ]);
      expect(state.bySessionId['sess-A']?.map((w) => w.id)).toEqual([
        'wf-a1',
        'wf-a2',
      ]);
      expect(state.bySessionId['sess-B']?.map((w) => w.id)).toEqual(['wf-b1']);

      // 未绑定任务的会话与空 sessionId 必须严格返回不可变常量 EMPTY_SESSION_SCHEDULES
      const { result: unboundHook1 } = renderHook(() =>
        useSessionSchedules('sess-unbound')
      );
      const { result: unboundHook2 } = renderHook(() =>
        useSessionSchedules(null)
      );

      expect(unboundHook1.current).toBe(EMPTY_SESSION_SCHEDULES);
      expect(unboundHook2.current).toBe(EMPTY_SESSION_SCHEDULES);
      expect(unboundHook1.current.length).toBe(0);
    });

    it('useSessionActiveScheduleCount 仅统计 enabled !== false 的活跃任务', () => {
      syncFromWorkflows([wfSessionA1, wfSessionA2Paused, wfSessionB1]);

      const { result: countA } = renderHook(() =>
        useSessionActiveScheduleCount('sess-A')
      );
      const { result: countB } = renderHook(() =>
        useSessionActiveScheduleCount('sess-B')
      );
      const { result: countUnbound } = renderHook(() =>
        useSessionActiveScheduleCount('sess-none')
      );

      // sess-A 共 2 个任务，其中 1 个 enabled: true，1 个 enabled: false -> 活跃数为 1
      expect(countA.current).toBe(1);
      expect(countB.current).toBe(1);
      expect(countUnbound.current).toBe(0);

      // 启用 wf-a2 后，sess-A 活跃数变为 2
      act(() => {
        syncFromWorkflows([
          wfSessionA1,
          { ...wfSessionA2Paused, enabled: true },
          wfSessionB1,
        ]);
      });
      expect(countA.current).toBe(2);
    });

    it('修改会话 A 的任务不会改变会话 B 的数组引用，实现会话级原子隔离', () => {
      syncFromWorkflows([wfSessionA1, wfSessionA2Paused, wfSessionB1]);

      const refA_initial =
        useSessionScheduleBadgeStore.getState().bySessionId['sess-A'];
      const refB_initial =
        useSessionScheduleBadgeStore.getState().bySessionId['sess-B'];
      expect(refA_initial).toBeDefined();
      expect(refB_initial).toBeDefined();

      let renderCountB = 0;
      const { result: hookB } = renderHook(() => {
        renderCountB++;
        return useSessionSchedules('sess-B');
      });
      expect(hookB.current).toBe(refB_initial);
      const initialRenderCountB = renderCountB;

      // 修改会话 A 的任务（将 wfSessionA2Paused 改为 enabled: true，并传入全新浅拷贝的 wfSessionB1）
      act(() => {
        syncFromWorkflows([
          { ...wfSessionA1, prompt: 'A1-updated' },
          { ...wfSessionA2Paused, enabled: true },
          { ...wfSessionB1 }, // 全新对象引用但实质内容完全一致
        ]);
      });

      const refA_after =
        useSessionScheduleBadgeStore.getState().bySessionId['sess-A'];
      const refB_after =
        useSessionScheduleBadgeStore.getState().bySessionId['sess-B'];

      // 会话 A 数组引用已更新
      expect(refA_after).not.toBe(refA_initial);
      // 会话 B 数组引用严格保持不变（===），且订阅会话 B 的 Hook 零额外重渲染
      expect(refB_after).toBe(refB_initial);
      expect(hookB.current).toBe(refB_initial);
      expect(renderCountB).toBe(initialRenderCountB);
    });
  });

  // =========================================================================
  // 维度 3：`WorkflowForm` 5 段式 Cron、全局工作区与目标会话绑定
  // =========================================================================
  describe('维度 3：WorkflowForm 5 段式 Cron、全局工作区与目标会话绑定', () => {
    function ControlledWorkflowFormWrapper(props: {
      initialDraft?: Partial<ExtendedWorkflowScheduleDraft>;
      variant?: 'settings' | 'chat';
      activeSessionId?: string;
      onDraftChangeSpy?: (d: WorkflowScheduleDraft) => void;
    }) {
      const [draft, setDraft] = useState<WorkflowScheduleDraft>(() => ({
        ...emptyWorkflowDraft(),
        ...props.initialDraft,
      }));
      return (
        <WorkflowForm
          variant={props.variant ?? 'chat'}
          formId="test-wf-form"
          draft={draft}
          busy={false}
          isEditing={false}
          activeSessionId={props.activeSessionId ?? 'sess-current-777'}
          onDraftChange={(next) => {
            setDraft(next);
            props.onDraftChangeSpy?.(next);
          }}
          onApplyPreset={vi.fn()}
          onNameBlur={vi.fn()}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />
      );
    }

    it('选择自定义 Cron 时渲染 5 段式输入框与标题行内联语义预览，无冗余预设胶囊', () => {
      const onDraftChangeSpy = vi.fn();
      render(
        <ControlledWorkflowFormWrapper
          initialDraft={{
            scheduleType: 'cron',
            cronExpression: '*/30 * * * *',
          }}
          onDraftChangeSpy={onDraftChangeSpy}
        />
      );

      // 验证 5 段式 Cron 区域与输入框渲染
      const cronSection = screen.getByTestId('workflow-cron-section');
      expect(cronSection).toBeInTheDocument();

      const cronInput = screen.getByLabelText(
        'Cron 表达式'
      ) as HTMLInputElement;
      expect(cronInput.value).toBe('*/30 * * * *');

      // 验证标题行内联语义预览显示
      const previewStatus = screen.getByTestId('cron-preview-status');
      expect(previewStatus.textContent).toBe('每 30 分钟');

      // 动态修改 Cron 表达式，实时内联更新
      fireEvent.change(cronInput, { target: { value: '0 9 * * 1-5' } });
      expect(cronInput.value).toBe('0 9 * * 1-5');
      expect(onDraftChangeSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          scheduleType: 'cron',
          cronExpression: '0 9 * * 1-5',
        })
      );
      expect(previewStatus.textContent).toBe('工作日 09:00');
    });

    it('项目下拉框支持“全局工作区”（cwd = ""），不会强制覆写为空外项目，且空 cwd 通过草稿校验', async () => {
      const onDraftChangeSpy = vi.fn();
      render(
        <ControlledWorkflowFormWrapper
          initialDraft={{
            name: '全局清理任务',
            prompt: '执行全局缓存巡检',
            cwd: '',
          }}
          onDraftChangeSpy={onDraftChangeSpy}
        />
      );

      // 挂载后绝不触发强制覆写 cwd 的副作用
      expect(onDraftChangeSpy).not.toHaveBeenCalled();

      // 验证所属项目下拉框默认选中“全局工作区”
      const projectCombo = screen.getByRole('combobox', { name: '所属项目' });
      expect(projectCombo).toHaveTextContent('🌐 全局工作区');

      // 展开下拉框，切换到具体项目，再切回全局工作区
      fireEvent.click(projectCombo);
      const projectOption = await screen.findByRole('option', {
        name: /Conex 核心仓/,
      });
      fireEvent.click(projectOption);
      expect(onDraftChangeSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ cwd: '/workspace/conex' })
      );

      fireEvent.click(projectCombo);
      const globalOption = await screen.findByRole('option', {
        name: /全局工作区/,
      });
      fireEvent.click(globalOption);
      expect(onDraftChangeSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ cwd: '' })
      );

      // 校验空 cwd 草稿合法通过
      const validGlobalDraft: WorkflowScheduleDraft = {
        ...emptyWorkflowDraft(''),
        name: '全局定时任务',
        prompt: '检查系统状态',
        cwd: '',
        scheduleType: 'cron',
        cronExpression: '0 9 * * 1-5',
      };
      expect(validateWorkflowDraft(validGlobalDraft)).toBeNull();
      expect(buildScheduleFromDraft(validGlobalDraft)).toEqual({
        type: 'cron',
        expression: '0 9 * * 1-5',
      });

      // 验证 draftFromWorkflow 单轨回填 cron 与 intervalMinutes
      const roundTripCron = draftFromWorkflow({
        name: 'Cron 回填',
        prompt: '执行',
        cwd: '',
        targetSessionId: 'sess-bound-9',
        schedule: { type: 'cron', expression: '0 9 * * 1-5' },
      });
      expect(roundTripCron.scheduleType).toBe('cron');
      expect(roundTripCron.cronExpression).toBe('0 9 * * 1-5');
      expect(roundTripCron.executionTarget).toBe('current_session');
      expect(roundTripCron.targetSessionId).toBe('sess-bound-9');
    });

    it('验证执行模式切换（后台独立执行 vs 绑定当前对话）与目标会话绑定/解绑', () => {
      const onDraftChangeSpy = vi.fn();
      render(
        <ControlledWorkflowFormWrapper
          initialDraft={{
            executionTarget: 'isolated_session',
            targetSessionId: '',
          }}
          activeSessionId="sess-active-888"
          onDraftChangeSpy={onDraftChangeSpy}
        />
      );

      const isolatedRadio = screen.getByRole('radio', {
        name: /后台独立执行/,
      });
      const currentSessionRadio = screen.getByRole('radio', {
        name: /绑定当前对话/,
      });

      expect(isolatedRadio).toHaveAttribute('aria-checked', 'true');
      expect(currentSessionRadio).toHaveAttribute('aria-checked', 'false');
      expect(screen.queryByLabelText('目标会话 ID')).toBeNull();

      // 切换到「绑定当前对话」模式：自动带入当前活跃会话 ID
      fireEvent.click(currentSessionRadio);
      expect(currentSessionRadio).toHaveAttribute('aria-checked', 'true');
      expect(onDraftChangeSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          executionTarget: 'current_session',
          targetSessionId: 'sess-active-888',
        })
      );

      const sessionInput = screen.getByLabelText(
        '目标会话 ID'
      ) as HTMLInputElement;
      expect(sessionInput.value).toBe('sess-active-888');

      // 手动修改目标会话 ID
      fireEvent.change(sessionInput, { target: { value: 'sess-custom-999' } });
      expect(sessionInput.value).toBe('sess-custom-999');

      // 点击「解绑对话」按钮切回后台独立执行并清空 targetSessionId
      const unbindBtn = screen.getByRole('button', { name: '解绑对话' });
      fireEvent.click(unbindBtn);

      expect(isolatedRadio).toHaveAttribute('aria-checked', 'true');
      expect(onDraftChangeSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          executionTarget: 'isolated_session',
          targetSessionId: '',
        })
      );
      expect(screen.queryByLabelText('目标会话 ID')).toBeNull();
    });
  });

  // =========================================================================
  // 维度 4：`WorkflowList` 行级独立锁与徽标展示
  // =========================================================================
  describe('维度 4：WorkflowList 行级独立锁与徽标展示', () => {
    const wfRow1: WorkflowDefinition = {
      id: 'wf-row-1',
      name: '全局对话巡检',
      prompt: '在绑定会话内汇报',
      cwd: '',
      targetSessionId: 'sess-bound-123',
      enabled: true,
      schedule: { type: 'cron', expression: '*/15 * * * *' },
    };

    const wfRow2: WorkflowDefinition = {
      id: 'wf-row-2',
      name: '项目构建检查',
      prompt: '检查构建产物',
      cwd: '/workspace/conex-engine',
      targetSessionId: null,
      enabled: true,
      schedule: { type: 'daily', time: '18:00', timezone: 'Asia/Shanghai' },
    };

    it('settings 变体：传入 togglingIds / triggeringIds 仅锁定目标行对应控件，绝不冻结其他行；正确展示绑定会话与全局工作区徽标', () => {
      const onToggle = vi.fn();
      const onTrigger = vi.fn();
      const onDelete = vi.fn();
      const onEdit = vi.fn();

      const { rerender } = render(
        <WorkflowList
          variant="settings"
          workflows={[wfRow1, wfRow2]}
          busy={false}
          togglingIds={new Set(['wf-row-1'])}
          triggeringIds={new Set()}
          emptyCopy={null}
          onToggle={onToggle}
          onTrigger={onTrigger}
          onDelete={onDelete}
          onEdit={onEdit}
        />
      );

      // 1) 验证徽标展示：wfRow1（空 cwd + targetSessionId）展示“🌐 全局工作区”与“💬 绑定会话”
      expect(screen.getByText(/🌐 全局工作区/)).toBeInTheDocument();
      expect(screen.getByText('💬 绑定会话')).toBeInTheDocument();
      // wfRow2（有 cwd + 无 targetSessionId）展示项目名，且全表仅 1 个“💬 绑定会话”徽标
      expect(screen.getByText(/项目: conex-engine/)).toBeInTheDocument();
      expect(screen.getAllByText('💬 绑定会话')).toHaveLength(1);

      // 2) 验证行级 togglingIds 锁隔离：仅 wfRow1 的开关/编辑/删除被禁用，wfRow1 立即运行及 wfRow2 全部控件保持可用
      const switchRow1 = screen.getByRole('switch', {
        name: '暂停 全局对话巡检',
      });
      const editRow1 = screen.getByRole('button', {
        name: '编辑 全局对话巡检',
      });
      const deleteRow1 = screen.getByRole('button', {
        name: '删除 全局对话巡检',
      });
      const triggerRow1 = screen.getByRole('button', {
        name: /立即执行 全局对话巡检/,
      });

      expect(switchRow1).toBeDisabled();
      expect(editRow1).toBeDisabled();
      expect(deleteRow1).toBeDisabled();
      expect(triggerRow1).not.toBeDisabled();

      const switchRow2 = screen.getByRole('switch', {
        name: '暂停 项目构建检查',
      });
      const editRow2 = screen.getByRole('button', {
        name: '编辑 项目构建检查',
      });
      const deleteRow2 = screen.getByRole('button', {
        name: '删除 项目构建检查',
      });
      const triggerRow2 = screen.getByRole('button', {
        name: /立即执行 项目构建检查/,
      });

      expect(switchRow2).not.toBeDisabled();
      expect(editRow2).not.toBeDisabled();
      expect(deleteRow2).not.toBeDisabled();
      expect(triggerRow2).not.toBeDisabled();

      // 点击 wfRow2 的开关可正常触发回调
      fireEvent.click(switchRow2);
      expect(onToggle).toHaveBeenCalledWith(wfRow2);

      // 3) 切换为 triggeringIds 锁定 wfRow2：仅 wfRow2 的立即运行/编辑/删除被禁用，wfRow2 的开关与 wfRow1 全部控件均可用
      rerender(
        <WorkflowList
          variant="settings"
          workflows={[wfRow1, wfRow2]}
          busy={false}
          togglingIds={new Set()}
          triggeringIds={new Set(['wf-row-2'])}
          emptyCopy={null}
          onToggle={onToggle}
          onTrigger={onTrigger}
          onDelete={onDelete}
          onEdit={onEdit}
        />
      );

      expect(
        screen.getByRole('switch', { name: '暂停 全局对话巡检' })
      ).not.toBeDisabled();
      expect(
        screen.getByRole('button', { name: /立即执行 全局对话巡检/ })
      ).not.toBeDisabled();
      expect(
        screen.getByRole('switch', { name: '暂停 项目构建检查' })
      ).not.toBeDisabled();
      expect(
        screen.getByRole('button', { name: /立即执行 项目构建检查/ })
      ).toBeDisabled();
      expect(
        screen.getByRole('button', { name: '编辑 项目构建检查' })
      ).toBeDisabled();
      expect(
        screen.getByRole('button', { name: '删除 项目构建检查' })
      ).toBeDisabled();
    });

    it('chat 变体：同样支持行级锁隔离、绑定会话徽标与全局工作区标签', () => {
      render(
        <WorkflowList
          variant="chat"
          workflows={[wfRow1, wfRow2]}
          busy={false}
          togglingIds={new Set(['wf-row-1'])}
          triggeringIds={new Set(['wf-row-2'])}
          emptyCopy={null}
          onToggle={vi.fn()}
          onTrigger={vi.fn()}
          onDelete={vi.fn()}
          onEdit={vi.fn()}
        />
      );

      expect(screen.getByText(/🌐 全局工作区/)).toBeInTheDocument();
      expect(screen.getByText(/项目: conex-engine/)).toBeInTheDocument();
      expect(screen.getAllByText('💬 绑定会话')).toHaveLength(1);

      // wfRow1 正在切换启停：暂停按钮禁用，立即触发按钮可用
      expect(
        screen.getByRole('button', { name: '暂停 全局对话巡检' })
      ).toBeDisabled();
      expect(
        screen.getByRole('button', { name: /立即触发 全局对话巡检/ })
      ).not.toBeDisabled();

      // wfRow2 正在立即触发：立即触发按钮禁用，暂停按钮可用
      expect(
        screen.getByRole('button', { name: /立即触发 项目构建检查/ })
      ).toBeDisabled();
      expect(
        screen.getByRole('button', { name: '暂停 项目构建检查' })
      ).not.toBeDisabled();
    });
  });

  // =========================================================================
  // 维度 5：`RunHistoryList` 历史孤儿 `interrupted` 状态渲染
  // =========================================================================
  describe('维度 5：RunHistoryList 历史孤儿 interrupted 状态渲染', () => {
    const mockWorkflows: WorkflowDefinition[] = [
      {
        id: 'wf-orphan',
        name: '夜间全量回归',
        prompt: '运行全量集成测试',
        enabled: false,
        schedule: { type: 'daily', time: '02:00' },
      },
    ];

    const interruptedRun: WorkflowRunEntry = {
      workflowId: 'wf-orphan',
      runId: 'run-orphan-1',
      sessionId: 'sess-orphan-1',
      triggerKind: 'cron',
      startedAt: '2026-10-12T02:00:00.000Z',
      durationMs: 12500,
      status: 'interrupted',
      prompt: '运行全量集成测试',
      outputSummary: '应用重启或任务暂停，历史孤儿执行已中断收口',
    };

    const activeRunningRun: WorkflowRunEntry = {
      workflowId: 'wf-orphan',
      runId: 'run-active-2',
      sessionId: 'sess-active-2',
      triggerKind: 'manual',
      startedAt: '2026-10-12T03:00:00.000Z',
      status: 'running',
      prompt: '运行全量集成测试',
    };

    it('status: "interrupted" 的运行记录渲染为“已中断”徽标，具备 data-status="interrupted"，绝不误判为蓝色运行中', () => {
      render(
        <RunHistoryList
          runs={[interruptedRun, activeRunningRun]}
          workflows={mockWorkflows}
        />
      );

      const interruptedBadge = screen.getByText('已中断');
      expect(interruptedBadge).toBeInTheDocument();
      expect(interruptedBadge).toHaveAttribute('data-status', 'interrupted');

      // 绝不能赋予蓝色运行中样式类 badgeRunning
      if (styles.badgeRunning) {
        expect(interruptedBadge.className).not.toContain(styles.badgeRunning);
      }
      if (styles.badgeInterrupted) {
        expect(interruptedBadge.className).toContain(styles.badgeInterrupted);
      }

      // 对比真实 running 条目：真实 running 渲染为“运行中”且包含 badgeRunning
      const runningBadge = screen.getByText('运行中');
      expect(runningBadge).toBeInTheDocument();
      expect(runningBadge).toHaveAttribute('data-status', 'running');
      if (styles.badgeRunning) {
        expect(runningBadge.className).toContain(styles.badgeRunning);
      }
      expect(interruptedBadge.className).not.toBe(runningBadge.className);
    });
  });
});
