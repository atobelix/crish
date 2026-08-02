/**
 * 定时任务共享状态 hook：SettingsScheduleTab 与 ScheduledTasksPanel 双面复用。
 * 收拢：加载（settings 12s 超时 / chat 本地缓存优先）、筛选、启停、立即执行、
 * 创建/编辑/删除、会话占位副作用与行内状态（成功静默，仅错误 toast）。
 * 差异由 surface 参数分流，两壳层行为保持一致。
 */
import { useEffect, useMemo, useState } from 'react';
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
  type WorkflowDefinition,
  type WorkflowRunEntry,
  type WorkflowScheduleDraft,
} from '../../api/workflowApi';
import {
  WORKFLOWS_LOAD_TIMEOUT_MS,
  ensureScheduledSession,
  loadWorkflowRunsCache,
  loadWorkflowsCache,
  matchesFilter,
  saveWorkflowRunsCache,
  saveWorkflowsCache,
  type ScheduleFilter,
  type WorkflowsSurface,
} from './workflowsSharedLib';

export type UseWorkflowsStateOptions = {
  surface: WorkflowsSurface;
  onShowToast: (msg: string) => void;
  /** settings 面：可选工作区路径（创建时写入 cwd） */
  workspacePath?: string;
};

export type UseWorkflowsStateResult = {
  workflows: WorkflowDefinition[];
  /** chat 面最近运行（settings 面恒空） */
  runs: WorkflowRunEntry[];
  loading: boolean;
  busy: boolean;
  error: string;
  ok: string;
  setError: (v: string) => void;
  setOk: (v: string) => void;
  filter: ScheduleFilter;
  setFilter: (v: ScheduleFilter) => void;
  filtered: WorkflowDefinition[];
  emptyCopy: { title: string; hint?: string } | null;
  refresh: () => Promise<void>;
  /** 创建成功返回 true（壳层据此关表单）；失败 false（行内 + toast 已处理） */
  handleCreate: (draft: WorkflowScheduleDraft) => Promise<boolean>;
  /** 保存成功返回 true（编辑用 editingWorkflow.id 更新；新建走 createWorkflow） */
  handleSave: (draft: WorkflowScheduleDraft, editingWorkflow: WorkflowDefinition | null) => Promise<boolean>;
  handleToggle: (w: WorkflowDefinition) => Promise<void>;
  handleTrigger: (w: WorkflowDefinition) => Promise<void>;
  handleDelete: (w: WorkflowDefinition) => Promise<void>;
  /** 监听类关键词提示：行内即可，禁止教育性 toast */
  maybeWatchHint: (text: string) => void;
  /** 失败：行内 + toast；成功路径禁止调用 */
  fail: (msg: string) => void;
  /** 表单/调度字段守卫：仅行内错误（避免填表时 toast 刷屏） */
  failInline: (msg: string) => void;
};

export function useWorkflowsState(
  opts: UseWorkflowsStateOptions,
): UseWorkflowsStateResult {
  const surface = opts.surface;
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>(() =>
    surface === 'chat' ? loadWorkflowsCache() : [],
  );
  const [runs, setRuns] = useState<WorkflowRunEntry[]>(() =>
    surface === 'chat' ? loadWorkflowRunsCache() : [],
  );
  const [loading, setLoading] = useState(() =>
    surface === 'chat' ? loadWorkflowsCache().length === 0 : false,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [filter, setFilter] = useState<ScheduleFilter>('all');

  const filtered = useMemo(
    () => workflows.filter((w) => matchesFilter(w, filter)),
    [workflows, filter],
  );

  const emptyCopy = useMemo(
    () =>
      resolveWorkflowJobsEmptyCopy({
        loading,
        totalCount: workflows.length,
        ...(surface === 'settings' ? { filteredCount: filtered.length } : {}),
        surface: surface === 'settings' ? 'settings' : 'list',
      }),
    [loading, workflows.length, filtered.length, surface],
  );

  const refresh = async () => {
    if (surface === 'chat') {
      if (workflows.length === 0) {
        setLoading(true);
      }
      try {
        const [wfs, rs] = await Promise.all([listWorkflows(), listWorkflowRuns()]);
        setWorkflows(wfs);
        saveWorkflowsCache(wfs);
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
      return;
    }
    setLoading(true);
    try {
      const list = await Promise.race([
        listWorkflows(),
        new Promise<never>((_, rej) => {
          window.setTimeout(() => rej(new Error('读取计划超时，请确认引擎已启动')), WORKFLOWS_LOAD_TIMEOUT_MS);
        }),
      ]);
      setWorkflows(list);
    } catch (e) {
      setError(networkUserMessage(e) || '读取计划失败');
      setWorkflows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (surface === 'chat') {
      void refresh();
      return;
    }
    setLoading(true);
    setError('');
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!cancelled) {
        setLoading(false);
        setError((prev) => prev || '读取计划超时，可点新建或稍后重试');
      }
    }, WORKFLOWS_LOAD_TIMEOUT_MS);
    void listWorkflows()
      .then((list) => {
        if (!cancelled) setWorkflows(list);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(networkUserMessage(e) || '读取计划失败');
        setWorkflows([]);
      })
      .finally(() => {
        window.clearTimeout(timer);
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    opts.onShowToast(msg);
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
    editingWorkflow: WorkflowDefinition | null,
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
    setBusy(true);
    setError('');
    try {
      if (editingWorkflow) {
        const res = await updateWorkflow(editingWorkflow.id, {
          name: draft.name.trim(),
          prompt: draft.prompt.trim(),
          schedule: schedGuard.schedule,
        });
        if (!res.ok) {
          fail(
            workflowActionErrorMessage(res.error, '保存失败，请检查引擎是否就绪', () =>
              networkUserMessage(),
            ),
          );
          return false;
        }
        setOk('已保存');
      } else {
        const res = await createWorkflow({
          name: draft.name.trim(),
          prompt: draft.prompt.trim(),
          schedule: schedGuard.schedule,
          ...(opts.workspacePath ? { cwd: opts.workspacePath } : {}),
          enabled: true,
        });
        if (!res.ok) {
          fail(
            workflowActionErrorMessage(res.error, '创建失败，请检查引擎是否就绪', () =>
              networkUserMessage(),
            ),
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
  const handleCreate = async (draft: WorkflowScheduleDraft): Promise<boolean> => {
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
    setBusy(true);
    setError('');
    try {
      const res = await createWorkflow({
        name: draft.name.trim(),
        prompt: draft.prompt.trim(),
        schedule: schedGuard.schedule,
        enabled: true,
      });
      if (!res.ok) {
        fail(
          workflowActionErrorMessage(res.error, '创建失败', () =>
            networkUserMessage(),
          ),
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
    setBusy(true);
    setError('');
    const enabling = w.enabled === false;
    try {
      const res = await updateWorkflow(w.id, { enabled: enabling });
      if (!res.ok) {
        fail(workflowActionErrorMessage(res.error, '更新失败', () => networkUserMessage()));
        return;
      }
      if (enabling) maybeWatchHint(`${w.name} ${w.prompt || ''}`);
      // 与 workflowEnabledLabel 同源中文
      setOk(workflowEnabledLabel(enabling));
      await refresh();
    } catch (e) {
      fail(networkUserMessage(e) || '更新失败');
    } finally {
      setBusy(false);
    }
  };

  const handleTrigger = async (w: WorkflowDefinition) => {
    setBusy(true);
    setError('');
    try {
      const res = await triggerWorkflow(w.id);
      if (!res.ok) {
        fail(workflowActionErrorMessage(res.error, '触发失败', () => networkUserMessage()));
        return;
      }
      // 成功：行内状态 + 侧栏占位；不 toast、不抢焦点
      setOk(workflowTriggerOkMessage(res.runId));
      if (res.sessionId) {
        ensureScheduledSession(res.sessionId, w.name, { activate: false });
      }
      await refresh();
    } catch (e) {
      fail(networkUserMessage(e) || '触发失败');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (w: WorkflowDefinition) => {
    setBusy(true);
    setError('');
    try {
      const res = await deleteWorkflow(w.id);
      if (!res.ok) {
        fail(workflowActionErrorMessage(res.error, '删除失败', () => networkUserMessage()));
        return;
      }
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
    error,
    ok,
    setError,
    setOk,
    filter,
    setFilter,
    filtered,
    emptyCopy,
    refresh,
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
