import { toast } from '../../services/toast/ToastContext';
/**
 * 定时任务共享状态 hook：SettingsScheduleTab 与 ScheduledTasksPanel 双面复用。
 * 收拢：加载（settings 12s 超时 / chat 本地缓存优先）、筛选、行级乐观启停、行级立即执行、
 * 创建/编辑/删除、会话占位副作用与行内状态（成功静默，仅错误 toast）。
 * 差异由 surface 参数分流，两壳层行为保持一致。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { listenWorkflowEvents } from '../../api/workflow-api/workflowEvents';
import { networkUserMessage } from '../../api/userFacingErrors';
import {
  createWorkflow,
  deleteWorkflow,
  listWorkflowRuns,
  listWorkflows,
  resolveWorkflowJobsEmptyCopy,
  triggerWorkflow,
  updateWorkflow,
  validateWorkflowDraft,
  validateWorkflowSchedule,
  watchTriggerHint,
  workflowActionErrorMessage,
  workflowEnabledLabel,
  workflowTriggerOkMessage,
  buildScheduleFromDraft,
  filterWorkflowsByWorkspace,
  type WorkflowDefinition,
  type WorkflowRunEntry,
  type WorkflowScheduleDraft,
} from '../../api/workflowApi';
import {
  syncFromWorkflows,
  type WorkflowDef,
} from '../../store/sessionScheduleBadgeStore';
import {
  ensureScheduledSession,
  loadWorkflowRunsCache,
  loadWorkflowsCache,
  matchesFilter,
  saveWorkflowRunsCache,
  saveWorkflowsCache,
  type ScheduleFilter,
  type WorkflowsSurface,
} from './workflowsSharedLib';

/** 乐观锁保护窗口（毫秒）：防止开关切换后被滞后的广播/轮询旧快照反向冲刷 */
export const OPTIMISTIC_LOCK_WINDOW_MS = 2000;

export type OptimisticLockEntry = {
  enabled: boolean;
  until: number;
};

type ExtendedWorkflowDraft = WorkflowScheduleDraft & {
  executionTarget?: 'current_session' | 'isolated_session' | string;
  targetSessionId?: string | null;
};

/**
 * 将后端返回的列表与本地乐观锁对齐：
 * - 若某工作流在乐观锁中且后端状态已对齐或窗口已过期，清除该锁条目；
 * - 若仍在窗口内（`now < lock.until`）且后端快照滞后，保持乐观锁中的 `enabled` 状态。
 */
export function reconcileWorkflowListWithLocks(
  incoming: WorkflowDefinition[],
  locks: Map<string, OptimisticLockEntry>,
  now: number = Date.now()
): WorkflowDefinition[] {
  for (const [id, lock] of locks.entries()) {
    if (now >= lock.until) {
      locks.delete(id);
    }
  }
  return incoming.map((w) => {
    const lock = locks.get(w.id);
    if (!lock) return w;
    const incomingEnabled = w.enabled !== false;
    if (incomingEnabled === lock.enabled) {
      locks.delete(w.id);
      return w;
    }
    if (now < lock.until) {
      return { ...w, enabled: lock.enabled };
    }
    locks.delete(w.id);
    return w;
  });
}

function resolveCreateTargetSessionId(
  draft: ExtendedWorkflowDraft
): string | undefined {
  const trimmed =
    typeof draft.targetSessionId === 'string'
      ? draft.targetSessionId.trim()
      : '';
  if (draft.executionTarget === 'current_session') {
    return trimmed || undefined;
  }
  if (draft.executionTarget === 'isolated_session') {
    return undefined;
  }
  return trimmed || undefined;
}

function resolveUpdateTargetSessionId(
  draft: ExtendedWorkflowDraft
): string | undefined {
  const trimmed =
    typeof draft.targetSessionId === 'string'
      ? draft.targetSessionId.trim()
      : '';
  if (draft.executionTarget === 'current_session') {
    return trimmed || '';
  }
  if (draft.executionTarget === 'isolated_session') {
    // 切回独立会话时传空字符串以在后端解绑 targetSessionId
    return '';
  }
  if (draft.targetSessionId !== undefined) {
    return trimmed;
  }
  return undefined;
}

export type UseWorkflowsStateOptions = {
  surface: WorkflowsSurface;
  /** settings 面：可选工作区路径（创建时写入 cwd） */
  workspacePath?: string;
};

export type UseWorkflowsStateResult = {
  workflows: WorkflowDefinition[];
  /** 最近运行历史 */
  runs: WorkflowRunEntry[];
  loading: boolean;
  /** 表单保存/新建/删除整体提交态（行级启停与立即触发已解耦至 togglingIds / triggeringIds） */
  busy: boolean;
  /** 行级启停并发锁集合 */
  togglingIds: Set<string>;
  /** 行级立即执行并发锁集合 */
  triggeringIds: Set<string>;
  error: string;
  ok: string;
  setError: (v: string) => void;
  setOk: (v: string) => void;
  filter: ScheduleFilter;
  setFilter: (v: ScheduleFilter) => void;
  filtered: WorkflowDefinition[];
  emptyCopy: { title: string; hint?: string } | null;
  refresh: () => Promise<void>;
  reconcileWorkflows: (incoming: WorkflowDefinition[]) => WorkflowDefinition[];
  /** 创建成功返回 true（壳层据此关表单）；失败 false（行内 + toast 已处理） */
  handleCreate: (draft: WorkflowScheduleDraft) => Promise<boolean>;
  /** 保存成功返回 true（编辑用 editingWorkflow.id 更新；新建走 createWorkflow） */
  handleSave: (
    draft: WorkflowScheduleDraft,
    editingWorkflow: WorkflowDefinition | null
  ) => Promise<boolean>;
  handleToggle: (w: WorkflowDefinition) => Promise<void>;
  handleTrigger: (wOrId: WorkflowDefinition | string) => Promise<void>;
  handleDelete: (w: WorkflowDefinition) => Promise<void>;
  /** 监听类关键词提示：行内即可，禁止教育性 toast */
  maybeWatchHint: (text: string) => void;
  /** 失败：行内 + toast；成功路径禁止调用 */
  fail: (msg: string) => void;
  /** 表单/调度字段守卫：仅行内错误（避免填表时 toast 刷屏） */
  failInline: (msg: string) => void;
};

export function useWorkflowsState(
  opts: UseWorkflowsStateOptions
): UseWorkflowsStateResult {
  const surface = opts.surface;
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>(() =>
    loadWorkflowsCache()
  );
  const [runs, setRuns] = useState<WorkflowRunEntry[]>(() =>
    loadWorkflowRunsCache()
  );
  const [loading, setLoading] = useState(
    () => loadWorkflowsCache().length === 0
  );
  const [busy, setBusy] = useState(false);
  const [togglingIds, setTogglingIds] = useState<Set<string>>(() => new Set());
  const [triggeringIds, setTriggeringIds] = useState<Set<string>>(
    () => new Set()
  );
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [filter, setFilter] = useState<ScheduleFilter>('all');

  const togglingIdsRef = useRef<Set<string>>(new Set());
  const triggeringIdsRef = useRef<Set<string>>(new Set());
  const optimisticLockUntilRef = useRef<Map<string, OptimisticLockEntry>>(
    new Map()
  );

  // 自动将当前工作流列表同步至会话定时任务徽标 Store（INT-06）
  useEffect(() => {
    syncFromWorkflows(workflows as WorkflowDef[]);
  }, [workflows]);

  const reconcileWorkflows = (
    incoming: WorkflowDefinition[]
  ): WorkflowDefinition[] => {
    return reconcileWorkflowListWithLocks(
      incoming,
      optimisticLockUntilRef.current,
      Date.now()
    );
  };

  const scopedWorkflows = useMemo(
    () =>
      opts.workspacePath
        ? filterWorkflowsByWorkspace(workflows, opts.workspacePath)
        : workflows,
    [workflows, opts.workspacePath]
  );

  const filtered = useMemo(
    () => scopedWorkflows.filter((w) => matchesFilter(w, filter)),
    [scopedWorkflows, filter]
  );

  const emptyCopy = useMemo(
    () =>
      resolveWorkflowJobsEmptyCopy({
        loading,
        totalCount: scopedWorkflows.length,
        ...(surface === 'settings' ? { filteredCount: filtered.length } : {}),
        surface: surface === 'settings' ? 'settings' : 'list',
      }),
    [loading, scopedWorkflows.length, filtered.length, surface]
  );

  const refresh = async () => {
    if (workflows.length === 0) {
      setLoading(true);
    }
    try {
      const [wfs, rs] = await Promise.all([
        listWorkflows(),
        listWorkflowRuns(),
      ]);
      const reconciled = reconcileWorkflows(wfs);
      setWorkflows(reconciled);
      saveWorkflowsCache(reconciled);
      syncFromWorkflows(reconciled as WorkflowDef[]);
      const sortedRuns = [...rs].sort((a, b) => {
        const ta = Date.parse(a.startedAt || a.scheduledFor || '') || 0;
        const tb = Date.parse(b.startedAt || b.scheduledFor || '') || 0;
        return tb - ta;
      });
      setRuns(sortedRuns);
      saveWorkflowRunsCache(sortedRuns);
    } catch (e) {
      setError(networkUserMessage(e) || '无法加载定时任务');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 全域状态实时同步：Rust 在 create/update/delete 成功落盘后广播
  // workflow:created/updated/deleted，refresh 经 reconcileWorkflows 保护乐观锁。
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenWorkflowEvents(() => {
      if (!disposed) void refreshRef.current();
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  /** 监听类关键词提示：行内即可，禁止教育性 toast（策略：仅错误+可撤销） */
  const maybeWatchHint = (text: string) => {
    const hint = watchTriggerHint(text);
    if (hint) setOk(hint);
  };

  /** 失败：行内 + toast；成功路径禁止调用 */
  const fail = (msg: string) => {
    setError(msg);
    setOk('');
    toast.show(msg);
  };

  /**
   * 表单/调度字段守卫：仅行内错误（避免填表时 toast 刷屏）。
   * API / 网络错误仍走 fail()。
   */
  const failInline = (msg: string) => {
    setError(msg);
    setOk('');
  };

  const handleSave = async (
    draft: WorkflowScheduleDraft,
    editingWorkflow: WorkflowDefinition | null
  ): Promise<boolean> => {
    const draftErr = validateWorkflowDraft(draft);
    if (draftErr) {
      failInline(draftErr);
      return false;
    }
    const schedule = buildScheduleFromDraft(draft);
    const schedGuard = validateWorkflowSchedule(schedule);
    if (schedGuard.ok === false) {
      failInline(schedGuard.error);
      return false;
    }
    const extDraft = draft as ExtendedWorkflowDraft;
    setBusy(true);
    setError('');
    try {
      if (editingWorkflow) {
        const patchTargetSessionId = resolveUpdateTargetSessionId(extDraft);
        const patchCwd =
          draft.cwd !== undefined
            ? draft.cwd.trim()
            : opts.workspacePath || undefined;
        const patchPayload = {
          name: draft.name.trim(),
          prompt: draft.prompt.trim(),
          schedule: schedGuard.schedule,
          cwd: patchCwd,
          ...(patchTargetSessionId !== undefined
            ? { targetSessionId: patchTargetSessionId }
            : {}),
        } as Parameters<typeof updateWorkflow>[1];
        const res = await updateWorkflow(editingWorkflow.id, patchPayload);
        if (!res.ok) {
          fail(
            workflowActionErrorMessage(
              res.error,
              '保存失败，请检查引擎是否就绪',
              () => networkUserMessage()
            )
          );
          return false;
        }
        if (res.workflow) {
          setWorkflows((prev) => {
            const next = prev.map((item) =>
              item.id === editingWorkflow.id
                ? { ...item, ...res.workflow }
                : item
            );
            saveWorkflowsCache(next);
            syncFromWorkflows(next as WorkflowDef[]);
            return next;
          });
        }
        setOk('已保存');
      } else {
        const targetCwd =
          (draft.cwd || '').trim() || opts.workspacePath || undefined;
        const targetSessionId = resolveCreateTargetSessionId(extDraft);
        const createPayload = {
          name: draft.name.trim(),
          prompt: draft.prompt.trim(),
          schedule: schedGuard.schedule,
          ...(targetCwd ? { cwd: targetCwd } : {}),
          ...(targetSessionId !== undefined ? { targetSessionId } : {}),
          enabled: true,
        } as Parameters<typeof createWorkflow>[0];
        const res = await createWorkflow(createPayload);
        if (!res.ok) {
          fail(
            workflowActionErrorMessage(
              res.error,
              '创建失败，请检查引擎是否就绪',
              () => networkUserMessage()
            )
          );
          return false;
        }
        setOk('已创建');
      }
      maybeWatchHint(`${draft.name} ${draft.prompt}`);
      await refresh();
      return true;
    } catch (e) {
      fail(networkUserMessage(e) || '保存失败');
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** chat 面新建：无编辑支路，成功仅行内不 toast */
  const handleCreate = async (
    draft: WorkflowScheduleDraft
  ): Promise<boolean> => {
    const draftErr = validateWorkflowDraft(draft);
    if (draftErr) {
      failInline(draftErr);
      return false;
    }
    const schedule = buildScheduleFromDraft(draft);
    const schedGuard = validateWorkflowSchedule(schedule);
    if (schedGuard.ok === false) {
      failInline(schedGuard.error);
      return false;
    }
    const extDraft = draft as ExtendedWorkflowDraft;
    setBusy(true);
    setError('');
    try {
      const targetCwd =
        (draft.cwd || '').trim() || opts.workspacePath || undefined;
      const targetSessionId = resolveCreateTargetSessionId(extDraft);
      const createPayload = {
        name: draft.name.trim(),
        prompt: draft.prompt.trim(),
        schedule: schedGuard.schedule,
        ...(targetCwd ? { cwd: targetCwd } : {}),
        ...(targetSessionId !== undefined ? { targetSessionId } : {}),
        enabled: true,
      } as Parameters<typeof createWorkflow>[0];
      const res = await createWorkflow(createPayload);
      if (!res.ok) {
        fail(
          workflowActionErrorMessage(res.error, '创建失败', () =>
            networkUserMessage()
          )
        );
        return false;
      }
      // 成功仅行内，不 toast
      setOk('已创建');
      maybeWatchHint(`${draft.name} ${draft.prompt}`);
      await refresh();
      return true;
    } catch (e) {
      fail(networkUserMessage(e) || '创建失败');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handleToggle = async (w: WorkflowDefinition) => {
    if (!w?.id) return;
    // 行级防重入：当前行正在切换时直接返回，绝不阻塞其他行
    if (togglingIdsRef.current.has(w.id) || togglingIds.has(w.id)) {
      return;
    }
    const prevEnabled = w.enabled !== false;
    const nextEnabled = !prevEnabled;

    togglingIdsRef.current.add(w.id);
    setTogglingIds((prev) => {
      const next = new Set(prev);
      next.add(w.id);
      return next;
    });
    setError('');

    // 写入 2000ms 乐观锁窗口并 0ms 乐观翻转当前行 enabled
    optimisticLockUntilRef.current.set(w.id, {
      enabled: nextEnabled,
      until: Date.now() + OPTIMISTIC_LOCK_WINDOW_MS,
    });
    setWorkflows((prev) => {
      const next = prev.map((item) =>
        item.id === w.id ? { ...item, enabled: nextEnabled } : item
      );
      saveWorkflowsCache(next);
      syncFromWorkflows(next as WorkflowDef[]);
      return next;
    });

    try {
      const res = await updateWorkflow(w.id, { enabled: nextEnabled });
      if (!res.ok) {
        optimisticLockUntilRef.current.delete(w.id);
        setWorkflows((prev) => {
          const next = prev.map((item) =>
            item.id === w.id ? { ...item, enabled: prevEnabled } : item
          );
          saveWorkflowsCache(next);
          syncFromWorkflows(next as WorkflowDef[]);
          return next;
        });
        fail(
          workflowActionErrorMessage(res.error, '更新失败', () =>
            networkUserMessage()
          )
        );
        return;
      }
      // 成功：用后端返回实体原地校准该行，并刷新 2000ms 乐观窗口防滞后快照冲刷
      optimisticLockUntilRef.current.set(w.id, {
        enabled: nextEnabled,
        until: Date.now() + OPTIMISTIC_LOCK_WINDOW_MS,
      });
      setWorkflows((prev) => {
        const next = prev.map((item) =>
          item.id === w.id
            ? res.workflow
              ? { ...item, ...res.workflow, enabled: nextEnabled }
              : { ...item, enabled: nextEnabled }
            : item
        );
        saveWorkflowsCache(next);
        syncFromWorkflows(next as WorkflowDef[]);
        return next;
      });
      if (nextEnabled) maybeWatchHint(`${w.name} ${w.prompt || ''}`);
      setOk(workflowEnabledLabel(nextEnabled));
    } catch (e) {
      optimisticLockUntilRef.current.delete(w.id);
      setWorkflows((prev) => {
        const next = prev.map((item) =>
          item.id === w.id ? { ...item, enabled: prevEnabled } : item
        );
        saveWorkflowsCache(next);
        syncFromWorkflows(next as WorkflowDef[]);
        return next;
      });
      fail(networkUserMessage(e) || '更新失败');
    } finally {
      togglingIdsRef.current.delete(w.id);
      setTogglingIds((prev) => {
        const next = new Set(prev);
        next.delete(w.id);
        return next;
      });
    }
  };

  const handleTrigger = async (wOrId: WorkflowDefinition | string) => {
    const workflowId =
      typeof wOrId === 'string' ? wOrId.trim() : String(wOrId?.id ?? '').trim();
    if (!workflowId) return;
    // 行级防重入：使用 triggeringIds 替代全局 busy 冻结
    if (
      triggeringIdsRef.current.has(workflowId) ||
      triggeringIds.has(workflowId)
    ) {
      return;
    }
    const workflowObj =
      typeof wOrId === 'object' && wOrId !== null
        ? wOrId
        : workflows.find((item) => item.id === workflowId);
    const workflowName = workflowObj?.name || '定时任务';

    triggeringIdsRef.current.add(workflowId);
    setTriggeringIds((prev) => {
      const next = new Set(prev);
      next.add(workflowId);
      return next;
    });
    setError('');
    try {
      const res = await triggerWorkflow(workflowId);
      if (!res.ok) {
        fail(
          workflowActionErrorMessage(res.error, '触发失败', () =>
            networkUserMessage()
          )
        );
        return;
      }
      // 成功：行内状态 + 侧栏占位；不 toast、不抢焦点，自动刷新运行历史 runs
      setOk(workflowTriggerOkMessage(res.runId));
      if (res.sessionId) {
        ensureScheduledSession(res.sessionId, workflowName, {
          activate: false,
        });
      }
      await refresh();
    } catch (e) {
      fail(networkUserMessage(e) || '触发失败');
    } finally {
      triggeringIdsRef.current.delete(workflowId);
      setTriggeringIds((prev) => {
        const next = new Set(prev);
        next.delete(workflowId);
        return next;
      });
    }
  };

  const handleDelete = async (w: WorkflowDefinition) => {
    setBusy(true);
    setError('');
    try {
      const res = await deleteWorkflow(w.id);
      if (!res.ok) {
        fail(
          workflowActionErrorMessage(res.error, '删除失败', () =>
            networkUserMessage()
          )
        );
        return;
      }
      optimisticLockUntilRef.current.delete(w.id);
      setOk('已删除');
      await refresh();
    } catch (e) {
      fail(networkUserMessage(e) || '删除失败');
    } finally {
      setBusy(false);
    }
  };

  return {
    workflows,
    runs,
    loading,
    busy,
    togglingIds,
    triggeringIds,
    error,
    ok,
    setError,
    setOk,
    filter,
    setFilter,
    filtered,
    emptyCopy,
    refresh,
    reconcileWorkflows,
    handleCreate,
    handleSave,
    handleToggle,
    handleTrigger,
    handleDelete,
    maybeWatchHint,
    fail,
    failInline,
  };
}
