/**
 * 主对话区 · 定时任务：与设置页同源 workflow API，嵌入 chat-doc-flow 展示。
 * 密度：无 essay、单行表单、紧凑列表；toast 仅错误；占位会话不抢焦点。
 * 空态中文契约、草稿调度守卫均走 workflowApi 纯助手。
 */
import React, { useEffect, useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
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
  listWorkflowRuns,
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
  workflowRunStatusLabel,
  workflowTriggerOkMessage,
  type WorkflowDefinition,
  type WorkflowRunEntry,
  type WorkflowScheduleDraft,
} from '../api/workflowApi';
import { clearAgentPanelFocus } from '../api/openAgentPanel';
import {
  createSession,
  getSessionById,
  renameSession,
  setActiveSessionId,
} from '../api/storeAccess';
import { SettingsSelect } from './SettingsSelect';
import styles from './ScheduledTasksPanel.module.css';
import { Tooltip } from './settings/SettingsUI';

type Props = {
  onShowToast: (msg: string) => void;
  onBackToChat: () => void;
};

/** 最近运行条数上限（对话内紧凑） */
const RECENT_RUNS_LIMIT = 10;

/**
 * 确保定时运行会话在侧栏可见。
 * - 默认 activate:false，不抢当前对话焦点
 * - 标题用「定时 · name」（非默认），避免空壳复用污染「新建」
 * - 仅覆盖默认/系统定时标题，不覆盖用户手动改名
 */
function ensureScheduledSession(
  sessionId: string | undefined,
  workflowName: string,
  opts?: { activate?: boolean },
) {
  if (!sessionId) return;
  const title = scheduledSessionTitle(workflowName);
  createSession({
    id: sessionId,
    title,
    // 仅 openRunSession 传 activate:true；触发成功一律 false
    activate: opts?.activate === true,
  });
  // createSession 只升级默认标题；系统「定时 ·」占位也允许按工作流名刷新
  const sess = getSessionById(sessionId);
  if (
    sess &&
    canReplaceSessionTitleWithScheduled(sess.title) &&
    sess.title !== title
  ) {
    renameSession(sessionId, title);
  }
}

function formatRunWhen(when: string): string {
  if (!when) return '—';
  const ms = Date.parse(when);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const WORKFLOWS_CACHE_KEY = 'crish_workflows_cache_v1';
const WORKFLOW_RUNS_CACHE_KEY = 'crish_workflow_runs_cache_v1';

function loadWorkflowsCache(): WorkflowDefinition[] {
  try {
    const raw = localStorage.getItem(WORKFLOWS_CACHE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveWorkflowsCache(list: WorkflowDefinition[]) {
  try {
    localStorage.setItem(WORKFLOWS_CACHE_KEY, JSON.stringify(list));
  } catch { /* ignore */ }
}

function loadWorkflowRunsCache(): WorkflowRunEntry[] {
  try {
    const raw = localStorage.getItem(WORKFLOW_RUNS_CACHE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveWorkflowRunsCache(list: WorkflowRunEntry[]) {
  try {
    localStorage.setItem(WORKFLOW_RUNS_CACHE_KEY, JSON.stringify(list));
  } catch { /* ignore */ }
}

export const ScheduledTasksPanel: React.FC<Props> = ({ onShowToast, onBackToChat }) => {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>(() => loadWorkflowsCache());
  const [runs, setRuns] = useState<WorkflowRunEntry[]>(() => loadWorkflowRunsCache());
  const [loading, setLoading] = useState(() => loadWorkflowsCache().length === 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<WorkflowScheduleDraft>(emptyWorkflowDraft);

  const emptyCopy = useMemo(
    () =>
      resolveWorkflowJobsEmptyCopy({
        loading,
        totalCount: workflows.length,
        surface: 'list',
      }),
    [loading, workflows.length],
  );

  const refresh = async () => {
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
  };

  const openRunSession = (run: WorkflowRunEntry) => {
    if (!run.sessionId) {
      // 无会话：错误路径，可 toast
      onShowToast('该次运行暂无关联会话');
      return;
    }
    const wfName = workflows.find((w) => w.id === run.workflowId)?.name || '任务';
    ensureScheduledSession(run.sessionId, wfName, { activate: true });
    setActiveSessionId(run.sessionId);
    clearAgentPanelFocus();
    onBackToChat();
    // 切会话即反馈，不 toast
  };

  useEffect(() => {
    void refresh();
  }, []);

  /** 监听类关键词提示：行内即可，禁止教育性 toast（策略：仅错误+可撤销） */
  const maybeWatchHint = (text: string) => {
    const hint = watchTriggerHint(text);
    if (hint) setOk(hint);
  };

  const applyPreset = (presetId: string) => {
    const preset = WORKFLOW_SCHEDULE_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setShowForm(true);
    setError('');
    setOk('');
    setDraft({ ...preset.draft });
  };

  const closeForm = () => {
    setShowForm(false);
    setError('');
    setOk('');
    setDraft(emptyWorkflowDraft());
  };

  /** 失败：行内 + toast；成功路径禁止调用 */
  const fail = (msg: string) => {
    setError(msg);
    setOk('');
    onShowToast(msg);
  };

  /**
   * 表单/调度字段守卫：仅行内错误（避免填表时 toast 刷屏）。
   * API / 网络错误仍走 fail()。
   */
  const failInline = (msg: string) => {
    setError(msg);
    setOk('');
  };

  const handleCreate = async () => {
    const draftErr = validateWorkflowDraft(draft);
    if (draftErr) {
      failInline(draftErr);
      return;
    }
    const schedule = buildScheduleFromDraft(draft);
    const schedGuard = validateWorkflowSchedule(schedule);
    if (schedGuard.ok === false) {
      failInline(schedGuard.error);
      return;
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
        return;
      }
      // 成功仅行内，不 toast
      setOk('已创建');
      setShowForm(false);
      maybeWatchHint(`${draft.name} ${draft.prompt}`);
      setDraft(emptyWorkflowDraft());
      await refresh();
    } catch (e) {
      fail(networkUserMessage(e) || '创建失败');
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
        fail(
          workflowActionErrorMessage(res.error, '触发失败', () =>
            networkUserMessage(),
          ),
        );
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

  const handleToggle = async (w: WorkflowDefinition) => {
    setBusy(true);
    setError('');
    const enabling = w.enabled === false;
    try {
      const res = await updateWorkflow(w.id, { enabled: enabling });
      if (!res.ok) {
        fail(
          workflowActionErrorMessage(res.error, '更新失败', () =>
            networkUserMessage(),
          ),
        );
        return;
      }
      if (enabling) maybeWatchHint(`${w.name} ${w.prompt || ''}`);
      // 与 workflowEnabledLabel 同源中文
      setOk(enabling ? '已启用' : '已暂停');
      await refresh();
    } catch (e) {
      fail(networkUserMessage(e) || '更新失败');
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
        fail(
          workflowActionErrorMessage(res.error, '删除失败', () =>
            networkUserMessage(),
          ),
        );
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

  const recentRuns = runs.slice(0, RECENT_RUNS_LIMIT);

  return (
    <div
      className={`${styles.schedInChat} ${styles.schedInChatDense}`}
      aria-busy={loading || busy}
      aria-label="定时任务"
    >
      <div className={styles.schedInChatHead}>
        <button
          type="button"
          className="ui-btn ui-btn-ghost ui-btn-sm"
          onClick={onBackToChat}
          aria-label="返回对话"
        >
          <Lucide.ArrowLeft size={16} aria-hidden />
          返回
        </button>
        <div className={styles.schedInChatTitles}>
          <h3 id="sched-in-chat-title">定时任务</h3>
          <span className={styles.schedInChatCount} aria-live="polite">
            {workflows.length > 0 ? `${workflows.length} 条` : ' '}
          </span>
        </div>
        <button
          type="button"
          className="ui-btn ui-btn-secondary ui-btn-sm"
          aria-expanded={showForm}
          aria-controls="sched-in-chat-form"
          onClick={() => {
            if (showForm) {
              closeForm();
            } else {
              setShowForm(true);
              setError('');
              setOk('');
            }
          }}
        >
          <Lucide.Plus size={16} aria-hidden />
          {showForm ? '收起' : '新建'}
        </button>
      </div>

      <div className={styles.schedPresetRow}>
        <div className={styles.schedPresetChips} role="group" aria-label="计划模板">
          {WORKFLOW_SCHEDULE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={styles.schedPresetChip}
              disabled={busy}
              onClick={() => applyPreset(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* 状态：aria-live 行内；成功永不 toast */}
      <div className="sched-status-live" aria-live="polite" aria-relevant="additions text">
        {error ? (
          <div className={`${styles.schedStatusLine} ${styles.isErr}`} role="alert" title={error}>
            {error}
          </div>
        ) : null}
        {ok && !error ? (
          <div className={`${styles.schedStatusLine} ${styles.isOk}`} role="status">
            {ok}
          </div>
        ) : null}
      </div>

      {showForm ? (
        <div
          id="sched-in-chat-form"
          className={`${styles.schedForm} ${styles.schedFormStack}`}
          role="form"
          aria-label="新建计划"
        >
          <label className={styles.schedField}>
            <span className={styles.schedFieldLabel}>名称</span>
            <input
              className={styles.schedFieldInput}
              placeholder="例如：每日代码体检"
              value={draft.name}
              disabled={busy}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              onBlur={() => maybeWatchHint(draft.name)}
              autoComplete="off"
            />
          </label>
          <label className={styles.schedField}>
            <span className={styles.schedFieldLabel}>要做什么</span>
            <textarea
              className={`${styles.schedFieldInput} ${styles.schedFieldTextarea}`}
              placeholder="描述任务内容…"
              value={draft.prompt}
              disabled={busy}
              rows={3}
              onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
            />
          </label>
          <div className={styles.schedFieldRow}>
            <label className={`${styles.schedField} ${styles.schedFieldGrow}`}>
              <span className={styles.schedFieldLabel}>频率</span>
              <SettingsSelect
                className={styles.schedSelect}
                value={draft.scheduleType}
                disabled={busy}
                options={WORKFLOW_SCHEDULE_TYPES.map((t) => ({
                  value: t.value,
                  label: t.label,
                  hint: t.hint,
                }))}
                onChange={(v) =>
                  setDraft((d) => ({
                    ...d,
                    scheduleType: v as WorkflowScheduleDraft['scheduleType'],
                  }))
                }
              />
            </label>
            {draft.scheduleType === 'daily' ? (
              <label className={styles.schedField}>
                <span className={styles.schedFieldLabel}>时间</span>
                <input
                  className={styles.schedFieldInput}
                  type="time"
                  value={draft.dailyTime}
                  disabled={busy}
                  onChange={(e) => setDraft((d) => ({ ...d, dailyTime: e.target.value }))}
                />
              </label>
            ) : null}
            {draft.scheduleType === 'intervalMinutes' ? (
              <label className={styles.schedField}>
                <span className={styles.schedFieldLabel}>间隔（分钟）</span>
                <input
                  className={styles.schedFieldInput}
                  type="number"
                  min={WORKFLOW_INTERVAL_MINUTES_MIN}
                  max={WORKFLOW_INTERVAL_MINUTES_MAX}
                  step={1}
                  inputMode="numeric"
                  placeholder={`${WORKFLOW_INTERVAL_MINUTES_MIN}–${WORKFLOW_INTERVAL_MINUTES_MAX}`}
                  value={draft.intervalMinutes}
                  disabled={busy}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, intervalMinutes: e.target.value }))
                  }
                />
              </label>
            ) : null}
          </div>
          <div className={styles.schedFormActions}>
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm"
              disabled={busy}
              aria-busy={busy}
              onClick={() => {
                void handleCreate();
              }}
            >
              {busy ? '…' : '保存'}
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-ghost ui-btn-sm"
              disabled={busy}
              onClick={closeForm}
            >
              取消
            </button>
          </div>
        </div>
      ) : null}

      {emptyCopy ? (
        <div
          className={`${styles.schedEmpty}${loading ? '' : ` ${styles.schedEmptyDense}`}`}
          role="status"
          aria-live="polite"
        >
          <span>{emptyCopy.title}</span>
          {emptyCopy.hint ? (
            <span className={styles.schedEmptySub}>{emptyCopy.hint}</span>
          ) : null}
        </div>
      ) : (
        <ul className={styles.schedList} aria-labelledby="sched-in-chat-title">
          {workflows.map((w) => {
            const paused = w.enabled === false;
            const toggleLabel = paused ? `启用 ${w.name}` : `暂停 ${w.name}`;
            return (
              <li key={w.id} className={`${styles.schedItem} ${styles.schedItemDense}`}>
                <div className={styles.schedItemMain}>
                  <div className={styles.schedItemName} title={w.prompt || w.name}>
                    {w.name}
                  </div>
                  <div className={styles.schedItemMeta}>
                    {scheduleLabel(w.schedule)}
                    {paused ? ` · ${workflowEnabledLabel(false)}` : ''}
                  </div>
                </div>
                <div className={styles.schedItemActions} role="group" aria-label={`${w.name} 操作`}>
                  <Tooltip content="立即触发">
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost ui-btn-sm"
                      aria-label={`立即触发 ${w.name}`}
                      disabled={busy}
                      onClick={() => {
                        void handleTrigger(w);
                      }}
                    >
                      <Lucide.Play size={16} aria-hidden />
                    </button>
                  </Tooltip>
                  <Tooltip content={paused ? '启用' : '暂停'}>
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost ui-btn-sm"
                      aria-label={toggleLabel}
                      aria-pressed={!paused}
                      disabled={busy}
                      onClick={() => {
                        void handleToggle(w);
                      }}
                    >
                      {paused ? (
                        <Lucide.PlayCircle size={16} aria-hidden />
                      ) : (
                        <Lucide.Pause size={16} aria-hidden />
                      )}
                    </button>
                  </Tooltip>
                  <Tooltip content="删除">
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost ui-btn-sm"
                      aria-label={`删除 ${w.name}`}
                      disabled={busy}
                      onClick={() => {
                        void handleDelete(w);
                      }}
                    >
                      <Lucide.Trash2 size={16} aria-hidden />
                    </button>
                  </Tooltip>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {recentRuns.length > 0 ? (
        <div className={styles.schedRuns}>
          <div className={styles.schedRunsH} id="sched-runs-heading">
            最近运行
          </div>
          <ul className={`${styles.schedList} ${styles.schedRunsList}`} aria-labelledby="sched-runs-heading">
            {recentRuns.map((r) => {
              const wfName =
                workflows.find((w) => w.id === r.workflowId)?.name || r.workflowId;
              const when = r.startedAt || r.scheduledFor || '';
              const whenLabel = formatRunWhen(when);
              const canOpen = Boolean(r.sessionId);
              return (
                <li
                  key={`${r.workflowId}-${r.runId}`}
                  className={`${styles.schedItem} ${styles.schedItemDense} ${styles.schedRunItem}`}
                >
                  <div className={styles.schedItemMain}>
                    <div className={styles.schedItemName}>{wfName}</div>
                    <div className={styles.schedItemMeta} title={r.error || undefined}>
                      {workflowRunStatusLabel(r.status)} · {whenLabel}
                      {r.error ? ` · ${r.error.slice(0, 24)}` : ''}
                    </div>
                  </div>
                  <div className={styles.schedItemActions}>
                    <Tooltip content={canOpen ? '打开会话' : '无关联会话'}>
                      <button
                        type="button"
                        className="ui-btn ui-btn-ghost ui-btn-sm"
                        aria-label={
                          canOpen ? `打开 ${wfName} 的运行会话` : `${wfName} 无关联会话`
                        }
                        disabled={!canOpen}
                        onClick={() => openRunSession(r)}
                      >
                        <Lucide.MessageSquare size={16} aria-hidden />
                      </button>
                    </Tooltip>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
};
