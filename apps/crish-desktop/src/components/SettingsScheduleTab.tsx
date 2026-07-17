/**
 * 设置 · 定时任务：筛选、新建、启停与立即执行；成功静默，仅错误提示。
 */
import React, { useEffect, useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import { getWorkspacePath } from '../api/projectStore';
import { emitUiEvent } from '../api/uiEvents';
import { networkUserMessage } from '../api/userFacingErrors';
import {
  WORKFLOW_INTERVAL_MINUTES_MAX,
  WORKFLOW_INTERVAL_MINUTES_MIN,
  WORKFLOW_SCHEDULE_PRESETS,
  WORKFLOW_SCHEDULE_TYPES,
  buildScheduleFromDraft,
  canReplaceSessionTitleWithScheduled,
  createWorkflow,
  deleteWorkflow,
  emptyWorkflowDraft,
  listWorkflows,
  resolveWorkflowJobsEmptyCopy,
  scheduleLabel,
  scheduledSessionTitle,
  triggerWorkflow,
  updateWorkflow,
  validateWorkflowDraft,
  validateWorkflowSchedule,
  watchTriggerHint,
  workflowActionErrorMessage,
  workflowEnabledLabel,
  workflowTriggerOkMessage,
  type WorkflowDefinition,
  type WorkflowScheduleDraft,
} from '../api/workflowApi';
import {
  createSession,
  getSessionById,
  renameSession,
} from '../api/storeAccess';
import { SettingsSelect } from './SettingsSelect';
import { useLayoutStore } from '../store/layoutStore';
import { setComposerSeed } from '../api/composerSeed';
import { closeSettings } from '../store/settingsUiStore';

type Props = {
  onShowToast: (msg: string) => void;
};

type ScheduleFilter = 'all' | 'enabled' | 'paused' | 'manual' | 'timed';

const FILTER_OPTIONS: { id: ScheduleFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'enabled', label: '启用中' },
  { id: 'paused', label: '暂停' },
  { id: 'manual', label: '仅手动' },
  { id: 'timed', label: '按时间' },
];

function scheduleTypeOf(w: WorkflowDefinition): string {
  const s = w.schedule;
  if (!s || typeof s !== 'object') return 'manual';
  return String((s as { type?: string }).type || 'manual');
}

function matchesFilter(w: WorkflowDefinition, filter: ScheduleFilter): boolean {
  const enabled = w.enabled !== false;
  const st = scheduleTypeOf(w);
  switch (filter) {
    case 'enabled':
      return enabled;
    case 'paused':
      return !enabled;
    case 'manual':
      return st === 'manual';
    case 'timed':
      return st === 'daily' || st === 'intervalMinutes';
    default:
      return true;
  }
}

/**
 * 触发后侧栏占位；不激活，避免抢走当前对话。
 * 标题「定时 · name」非默认，不进空壳复用，避免污染「新建」。
 */
function ensureScheduledSessionPlaceholder(
  sessionId: string | undefined,
  workflowName: string,
) {
  if (!sessionId) return;
  const title = scheduledSessionTitle(workflowName);
  createSession({
    id: sessionId,
    title,
    activate: false,
  });
  const sess = getSessionById(sessionId);
  if (
    sess &&
    canReplaceSessionTitleWithScheduled(sess.title) &&
    sess.title !== title
  ) {
    renameSession(sessionId, title);
  }
}

export const SettingsScheduleTab: React.FC<Props> = ({ onShowToast }) => {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [workflowsLoading, setWorkflowsLoading] = useState(false);
  const [wfBusy, setWfBusy] = useState(false);
  const [wfError, setWfError] = useState('');
  const [wfOk, setWfOk] = useState('');
  /** none | paths 双入口 | form 手动表单 */
  const [createMode, setCreateMode] = useState<'none' | 'paths' | 'form'>('none');
  const [filter, setFilter] = useState<ScheduleFilter>('all');
  const [wfDraft, setWfDraft] = useState<WorkflowScheduleDraft>(emptyWorkflowDraft);

  const workspacePath = getWorkspacePath() || '';

  const filtered = useMemo(
    () => workflows.filter((w) => matchesFilter(w, filter)),
    [workflows, filter],
  );

  const emptyCopy = useMemo(
    () =>
      resolveWorkflowJobsEmptyCopy({
        loading: workflowsLoading,
        totalCount: workflows.length,
        filteredCount: filtered.length,
        surface: 'settings',
      }),
    [workflowsLoading, workflows.length, filtered.length],
  );

  const stats = useMemo(() => {
    const total = workflows.length;
    const enabled = workflows.filter((w) => w.enabled !== false).length;
    const disabled = total - enabled;
    return { total, enabled, disabled };
  }, [workflows]);

  const scheduleTypeHint = useMemo(
    () =>
      WORKFLOW_SCHEDULE_TYPES.find((t) => t.value === wfDraft.scheduleType)?.hint ||
      '',
    [wfDraft.scheduleType],
  );

  const refreshWorkflows = async () => {
    setWorkflowsLoading(true);
    try {
      const list = await Promise.race([
        listWorkflows(),
        new Promise<never>((_, rej) => {
          window.setTimeout(() => rej(new Error('读取计划超时，请确认引擎已启动')), 12_000);
        }),
      ]);
      setWorkflows(list);
    } catch (e) {
      setWfError(networkUserMessage(e) || '读取计划失败');
      setWorkflows([]);
    } finally {
      setWorkflowsLoading(false);
    }
  };

  useEffect(() => {
    setWorkflowsLoading(true);
    setWfError('');
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!cancelled) {
        setWorkflowsLoading(false);
        setWfError((prev) => prev || '读取计划超时，可点新建或稍后重试');
      }
    }, 12_000);
    void listWorkflows()
      .then((list) => {
        if (!cancelled) setWorkflows(list);
      })
      .catch((e) => {
        if (cancelled) return;
        setWfError(networkUserMessage(e) || '读取计划失败');
        setWorkflows([]);
      })
      .finally(() => {
        window.clearTimeout(timer);
        if (!cancelled) setWorkflowsLoading(false);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const resetDraft = () => {
    setWfDraft(emptyWorkflowDraft());
  };

  const closeForm = () => {
    setCreateMode('none');
    setWfError('');
    setWfOk('');
    resetDraft();
  };

  const openMainScheduled = () => {
    useLayoutStore.getState().setShowSettingsOverlay(false);
    emitUiEvent('open-scheduled');
  };

  const applyPreset = (presetId: string) => {
    const preset = WORKFLOW_SCHEDULE_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setCreateMode('form');
    setWfError('');
    setWfOk('');
    setWfDraft({ ...preset.draft });
  };

  /** 关闭设置，在对话里用 AI 写定时任务名称与提示词 */
  const handleAiCreateSchedule = () => {
    setComposerSeed(
      [
        '请帮我设计一个 Crish 定时任务。',
        '输出：任务名称、触发方式（手动 / 每日时刻 / 间隔分钟）、完整提示词（可直接粘贴使用）。',
        '我想用它来：',
      ].join('\n'),
    );
    setCreateMode('none');
    closeSettings();
    emitUiEvent('open-chat');
  };

  /** 监听类关键词提示：行内即可，禁止教育性 toast（策略：仅错误+可撤销） */
  const maybeWatchHint = (text: string) => {
    const hint = watchTriggerHint(text);
    if (hint) setWfOk(hint);
  };

  /** 失败：行内 + toast；成功路径禁止调用 */
  const fail = (msg: string) => {
    setWfError(msg);
    setWfOk('');
    onShowToast(msg);
  };

  /**
   * 表单/调度字段守卫：仅行内错误（避免填表时 toast 刷屏）。
   * API / 网络错误仍走 fail()。
   */
  const failInline = (msg: string) => {
    setWfError(msg);
    setWfOk('');
  };

  const handleCreate = async () => {
    const draftErr = validateWorkflowDraft(wfDraft);
    if (draftErr) {
      failInline(draftErr);
      return;
    }
    const schedule = buildScheduleFromDraft(wfDraft);
    const schedGuard = validateWorkflowSchedule(schedule);
    if (schedGuard.ok === false) {
      failInline(schedGuard.error);
      return;
    }
    setWfBusy(true);
    setWfError('');
    try {
      const res = await createWorkflow({
        name: wfDraft.name.trim(),
        prompt: wfDraft.prompt.trim(),
        schedule: schedGuard.schedule,
        cwd: workspacePath || undefined,
        enabled: true,
      });
      if (!res.ok) {
        fail(
          workflowActionErrorMessage(res.error, '创建失败，请检查引擎是否就绪', () =>
            networkUserMessage(),
          ),
        );
        return;
      }
      // 成功仅行内，不 toast
      setWfOk('已创建');
      setCreateMode('none');
      maybeWatchHint(`${wfDraft.name} ${wfDraft.prompt}`);
      resetDraft();
      await refreshWorkflows();
    } catch (e) {
      fail(networkUserMessage(e) || '创建失败');
    } finally {
      setWfBusy(false);
    }
  };

  const handleToggle = async (w: WorkflowDefinition) => {
    setWfBusy(true);
    setWfError('');
    const enabling = w.enabled === false;
    try {
      const res = await updateWorkflow(w.id, { enabled: enabling });
      if (!res.ok) {
        fail(workflowActionErrorMessage(res.error, '更新失败', () => networkUserMessage()));
        return;
      }
      // 与 workflowEnabledLabel 同源中文；成功仅行内
      setWfOk(workflowEnabledLabel(enabling));
      if (enabling) maybeWatchHint(`${w.name} ${w.prompt || ''}`);
      await refreshWorkflows();
    } catch (e) {
      fail(networkUserMessage(e) || '更新失败');
    } finally {
      setWfBusy(false);
    }
  };

  const handleTrigger = async (w: WorkflowDefinition) => {
    setWfBusy(true);
    setWfError('');
    try {
      const res = await triggerWorkflow(w.id);
      if (!res.ok) {
        // 触发失败：toast + 行内；成功仅行内
        fail(workflowActionErrorMessage(res.error, '触发失败', () => networkUserMessage()));
        return;
      }
      ensureScheduledSessionPlaceholder(res.sessionId, w.name);
      setWfOk(workflowTriggerOkMessage(res.runId));
    } catch (e) {
      fail(networkUserMessage(e) || '触发失败');
    } finally {
      setWfBusy(false);
    }
  };

  const handleDelete = async (w: WorkflowDefinition) => {
    setWfBusy(true);
    setWfError('');
    try {
      const res = await deleteWorkflow(w.id);
      if (!res.ok) {
        fail(workflowActionErrorMessage(res.error, '删除失败', () => networkUserMessage()));
        return;
      }
      setWfOk('已删除');
      await refreshWorkflows();
    } catch (e) {
      fail(networkUserMessage(e) || '删除失败');
    } finally {
      setWfBusy(false);
    }
  };

  return (
    <div
      className="settings-pane settings-pane--modern sched-settings"
      aria-busy={workflowsLoading || wfBusy}
      aria-label="定时任务"
    >
      <header className="settings-page-head">
        <div className="sched-settings-head">
          <h2 className="settings-page-title" id="sched-settings-title">
            定时任务
          </h2>
          <button
            type="button"
            className="ui-btn ui-btn-ghost ui-btn-sm"
            onClick={openMainScheduled}
            aria-label="在主界面打开"
            title="在主界面打开"
          >
            主界面打开
          </button>
        </div>
        <p
          className="sched-settings-stats"
          title="任务概况"
          aria-live="polite"
        >
          {stats.total === 0
            ? '暂无任务'
            : `${stats.total} 个 · ${stats.enabled} 启用 · ${stats.disabled} 暂停`}
        </p>
      </header>

      <div className="sched-settings-toolbar" role="toolbar" aria-label="筛选与新建">
        <div className="settings-choice-group" role="group" aria-label="任务筛选">
          {FILTER_OPTIONS.map((opt) => {
            const active = filter === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                className={`settings-choice-btn ${active ? 'active' : ''}`}
                aria-pressed={active}
                onClick={() => setFilter(opt.id)}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="ui-btn ui-btn-secondary ui-btn-sm settings-btn-rect"
          aria-expanded={createMode !== 'none'}
          aria-controls="sched-settings-form"
          disabled={wfBusy}
          onClick={() => {
            if (createMode !== 'none') {
              closeForm();
            } else {
              setCreateMode('paths');
              setWfError('');
              setWfOk('');
            }
          }}
        >
          <Lucide.Plus size={16} aria-hidden />
          {createMode !== 'none' ? '收起' : '新建'}
        </button>
      </div>

      {(wfError || wfOk) && (
        <div
          className="sched-settings-status"
          aria-live="polite"
          aria-relevant="additions text"
        >
          {wfError ? (
            <span className="settings-list-sub settings-list-sub--force" role="alert">
              {wfError}
            </span>
          ) : null}
          {wfOk && !wfError ? (
            <span className="settings-list-sub settings-list-sub--force" role="status">
              {wfOk}
            </span>
          ) : null}
        </div>
      )}

      {createMode === 'paths' ? (
        <div className="settings-create-paths" id="sched-settings-form">
          <button
            type="button"
            className="settings-create-path"
            onClick={handleAiCreateSchedule}
          >
            <span className="settings-create-path-title">用对话创建</span>
            <span className="settings-create-path-desc">
              描述目标和频率，让 AI 帮你写好（推荐）
            </span>
          </button>
          <button
            type="button"
            className="settings-create-path"
            onClick={() => {
              setCreateMode('form');
              setWfError('');
              setWfOk('');
            }}
          >
            <span className="settings-create-path-title">手动创建</span>
            <span className="settings-create-path-desc">
              自己填名称、内容和触发方式
            </span>
          </button>
        </div>
      ) : null}

      {createMode === 'form' ? (
        <div
          id="sched-settings-form"
          className="sched-settings-form"
          role="form"
          aria-label="新建定时任务"
        >
          <div className="sched-preset-chips" role="group" aria-label="模板">
            {WORKFLOW_SCHEDULE_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className="sched-preset-chip"
                disabled={wfBusy}
                onClick={() => applyPreset(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="sched-settings-form-row sched-settings-form-row--fields">
            <input
              className="settings-field-input"
              placeholder="名称"
              value={wfDraft.name}
              disabled={wfBusy}
              onChange={(e) => setWfDraft((d) => ({ ...d, name: e.target.value }))}
              onBlur={() => maybeWatchHint(wfDraft.name)}
              aria-label="名称"
              autoComplete="off"
            />
            <input
              className="settings-field-input sched-settings-prompt"
              placeholder="要执行的内容"
              value={wfDraft.prompt}
              disabled={wfBusy}
              onChange={(e) => setWfDraft((d) => ({ ...d, prompt: e.target.value }))}
              aria-label="执行内容"
              autoComplete="off"
            />
          </div>
          <div className="sched-settings-form-row">
            <SettingsSelect
              className="sched-settings-select"
              value={wfDraft.scheduleType}
              disabled={wfBusy}
              options={WORKFLOW_SCHEDULE_TYPES.map((t) => ({
                value: t.value,
                label: t.label,
                hint: t.hint,
              }))}
              onChange={(v) =>
                setWfDraft((d) => ({
                  ...d,
                  scheduleType: v as WorkflowScheduleDraft['scheduleType'],
                }))
              }
            />
            {wfDraft.scheduleType === 'daily' ? (
              <input
                className="settings-field-input"
                type="time"
                value={wfDraft.dailyTime}
                disabled={wfBusy}
                onChange={(e) => setWfDraft((d) => ({ ...d, dailyTime: e.target.value }))}
                aria-label="每日时刻"
              />
            ) : null}
            {wfDraft.scheduleType === 'intervalMinutes' ? (
              <input
                className="settings-field-input"
                type="number"
                min={WORKFLOW_INTERVAL_MINUTES_MIN}
                max={WORKFLOW_INTERVAL_MINUTES_MAX}
                step={1}
                inputMode="numeric"
                placeholder={`${WORKFLOW_INTERVAL_MINUTES_MIN}–${WORKFLOW_INTERVAL_MINUTES_MAX} 分钟`}
                value={wfDraft.intervalMinutes}
                disabled={wfBusy}
                onChange={(e) =>
                  setWfDraft((d) => ({ ...d, intervalMinutes: e.target.value }))
                }
                aria-label="间隔分钟"
              />
            ) : null}
            <button
              type="button"
              className="ui-btn ui-btn-ghost ui-btn-sm"
              disabled={wfBusy}
              onClick={closeForm}
            >
              取消
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm"
              disabled={wfBusy}
              aria-busy={wfBusy}
              onClick={() => {
                void handleCreate();
              }}
            >
              {wfBusy ? '…' : '创建'}
            </button>
          </div>
          {workspacePath ? (
            <div className="sched-settings-path" title={workspacePath}>
              {workspacePath}
            </div>
          ) : null}
        </div>
      ) : null}

      {emptyCopy ? (
        <div className="sched-settings-empty" role="status" aria-live="polite">
          {emptyCopy.title}
          {emptyCopy.hint ? (
            <span className="settings-list-sub settings-list-sub--force">
              {' '}
              {emptyCopy.hint}
            </span>
          ) : null}
        </div>
      ) : (
        <div
          className="sched-settings-list"
          role="list"
          aria-labelledby="sched-settings-title"
        >
          {filtered.map((w) => {
            const enabled = w.enabled !== false;
            const statusLabel = workflowEnabledLabel(enabled);
            const schedText = scheduleLabel(w.schedule);
            return (
              <div key={w.id} className="sched-settings-row" role="listitem">
                <span
                  className="sched-settings-row-name"
                  title={w.prompt || w.name}
                >
                  {w.name}
                </span>
                <span
                  className="sched-settings-row-schedule"
                  title={`${schedText}${enabled ? '' : ` · ${statusLabel}`}`}
                >
                  {schedText}
                  {!enabled ? ` · ${statusLabel}` : ''}
                </span>
                <input
                  type="checkbox"
                  className="settings-switch"
                  checked={enabled}
                  disabled={wfBusy}
                  title={enabled ? '暂停' : '启用'}
                  aria-label={enabled ? `暂停 ${w.name}` : `启用 ${w.name}`}
                  onChange={() => {
                    void handleToggle(w);
                  }}
                />
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost ui-btn-sm"
                  title="立即执行"
                  aria-label={`立即执行 ${w.name}`}
                  disabled={wfBusy}
                  onClick={() => {
                    void handleTrigger(w);
                  }}
                >
                  <Lucide.Zap size={16} aria-hidden />
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost ui-btn-sm"
                  title="删除"
                  aria-label={`删除 ${w.name}`}
                  disabled={wfBusy}
                  onClick={() => {
                    void handleDelete(w);
                  }}
                >
                  <Lucide.Trash2 size={16} aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
