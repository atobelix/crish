/**
 * 主对话区 · 定时任务：与设置页同源 workflow API，嵌入 chat-doc-flow 展示。
 */
import React, { useEffect, useState } from 'react';
import * as Lucide from 'lucide-react';
import { networkUserMessage } from '../api/userFacingErrors';
import {
  WORKFLOW_SCHEDULE_CAPABILITY_NOTE,
  WORKFLOW_SCHEDULE_PRESETS,
  WORKFLOW_SCHEDULE_TYPES,
  buildScheduleFromDraft,
  createWorkflow,
  deleteWorkflow,
  emptyWorkflowDraft,
  listWorkflowRuns,
  listWorkflows,
  scheduleLabel,
  triggerWorkflow,
  updateWorkflow,
  watchTriggerHint,
  workflowRunStatusLabel,
  type WorkflowDefinition,
  type WorkflowRunEntry,
  type WorkflowScheduleDraft,
} from '../api/workflowApi';
import { useLayoutStore } from '../store/layoutStore';

type Props = {
  onShowToast: (msg: string) => void;
  onBackToChat: () => void;
};

export const ScheduledTasksPanel: React.FC<Props> = ({ onShowToast, onBackToChat }) => {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [runs, setRuns] = useState<WorkflowRunEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<WorkflowScheduleDraft>(emptyWorkflowDraft);

  const refresh = async () => {
    setLoading(true);
    try {
      const [wfs, rs] = await Promise.all([listWorkflows(), listWorkflowRuns()]);
      setWorkflows(wfs);
      // 最近优先
      setRuns(
        [...rs].sort((a, b) => {
          const ta = Date.parse(a.startedAt || a.scheduledFor || '') || 0;
          const tb = Date.parse(b.startedAt || b.scheduledFor || '') || 0;
          return tb - ta;
        }),
      );
    } catch (e) {
      setError(networkUserMessage(e) || '无法加载定时任务');
    } finally {
      setLoading(false);
    }
  };

  const openRunSession = (run: WorkflowRunEntry) => {
    if (!run.sessionId) {
      onShowToast('该次运行暂无关联会话');
      return;
    }
    const st = useLayoutStore.getState();
    // 若本地尚无此会话，先建占位，便于从侧栏看到
    const exists = st.sessions.some((s) => s.id === run.sessionId);
    if (!exists) {
      st.createSession({
        id: run.sessionId,
        title: `定时 · ${workflows.find((w) => w.id === run.workflowId)?.name || '任务'}`,
      });
    }
    st.setActiveSessionId(run.sessionId);
    st.setActiveAgentId(null);
    onBackToChat();
    onShowToast('已打开该次运行对应会话');
  };

  useEffect(() => {
    void refresh();
  }, []);

  const maybeWatchHint = (text: string) => {
    const hint = watchTriggerHint(text);
    if (hint) onShowToast(hint);
  };

  const applyPreset = (presetId: string) => {
    const preset = WORKFLOW_SCHEDULE_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setShowForm(true);
    setError('');
    setOk('');
    setDraft({ ...preset.draft });
    onShowToast(`已预填「${preset.label}」，可改后保存`);
  };

  return (
    <div className="sched-in-chat">
      <div className="sched-in-chat-head">
        <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onBackToChat}>
          <Lucide.ArrowLeft size={16} />
          返回对话
        </button>
        <div className="sched-in-chat-titles">
          <h3>定时任务</h3>
          <p>
            引擎 workflow：
            {WORKFLOW_SCHEDULE_TYPES.map((t) => t.label).join(' / ')}
            。在此管理，不占用设置页主路径。
          </p>
        </div>
        <button
          type="button"
          className="ui-btn ui-btn-secondary ui-btn-sm"
          onClick={() => {
            setShowForm((v) => !v);
            setError('');
            setOk('');
          }}
        >
          <Lucide.Plus size={16} />
          新建
        </button>
      </div>

      <div className="sched-capability-note" role="note">
        {WORKFLOW_SCHEDULE_CAPABILITY_NOTE}
      </div>

      <div className="sched-preset-row">
        <span className="sched-preset-label">模板</span>
        <div className="sched-preset-chips" role="group" aria-label="计划模板">
          {WORKFLOW_SCHEDULE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="sched-preset-chip"
              onClick={() => applyPreset(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {error ? <div className="model-picker-error" style={{ marginBottom: 8 }}>{error}</div> : null}
      {ok ? (
        <div className="chat-soft-hint" style={{ marginBottom: 8 }}>
          <span>{ok}</span>
        </div>
      ) : null}

      {showForm ? (
        <div className="sched-form">
          <div className="sched-form-title">新建计划</div>
          <input
            className="settings-field-input"
            placeholder="名称，例如 每日代码体检"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            onBlur={() => maybeWatchHint(draft.name)}
          />
          <textarea
            className="settings-field-input"
            style={{ minHeight: 72, resize: 'vertical', fontFamily: 'inherit' }}
            placeholder="每次触发时发给助手的任务说明"
            value={draft.prompt}
            onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
          />
          <div className="sched-form-row">
            <label>周期</label>
            <select
              className="settings-field-input"
              value={draft.scheduleType}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  scheduleType: e.target.value as WorkflowScheduleDraft['scheduleType'],
                }))
              }
            >
              {WORKFLOW_SCHEDULE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div className="sched-form-hint">
            {WORKFLOW_SCHEDULE_TYPES.find((t) => t.value === draft.scheduleType)?.hint}
          </div>
          {draft.scheduleType === 'daily' ? (
            <input
              className="settings-field-input"
              type="time"
              value={draft.dailyTime}
              onChange={(e) => setDraft((d) => ({ ...d, dailyTime: e.target.value }))}
            />
          ) : null}
          {draft.scheduleType === 'intervalMinutes' ? (
            <input
              className="settings-field-input"
              type="number"
              min={1}
              value={draft.intervalMinutes}
              onChange={(e) => setDraft((d) => ({ ...d, intervalMinutes: e.target.value }))}
            />
          ) : null}
          <div className="sched-form-actions">
            <button
              type="button"
              className="ui-btn ui-btn-primary ui-btn-sm"
              disabled={busy}
              onClick={() => {
                if (!draft.name.trim() || !draft.prompt.trim()) {
                  setError('请填写名称与任务说明');
                  return;
                }
                setBusy(true);
                setError('');
                void createWorkflow({
                  name: draft.name.trim(),
                  prompt: draft.prompt.trim(),
                  schedule: buildScheduleFromDraft(draft),
                  enabled: true,
                })
                  .then(() => {
                    setOk('已创建');
                    setShowForm(false);
                    maybeWatchHint(`${draft.name} ${draft.prompt}`);
                    setDraft(emptyWorkflowDraft());
                    return refresh();
                  })
                  .catch((e) => setError(networkUserMessage(e) || '创建失败'))
                  .finally(() => setBusy(false));
              }}
            >
              保存
            </button>
            <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setShowForm(false)}>
              取消
            </button>
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="sched-empty">加载中…</div>
      ) : workflows.length === 0 ? (
        <div className="sched-empty">
          <Lucide.Clock size={28} style={{ opacity: 0.35 }} />
          <div>暂无定时任务</div>
          <div className="sched-empty-sub">点上方模板快速创建，或让助手在对话中帮你配置 workflow。</div>
        </div>
      ) : (
        <ul className="sched-list">
          {workflows.map((w) => (
            <li key={w.id} className="sched-item">
              <div className="sched-item-main">
                <div className="sched-item-name">{w.name}</div>
                <div className="sched-item-meta">
                  {scheduleLabel(w.schedule)}
                  {w.enabled === false ? ' · 已暂停' : ''}
                </div>
                <div className="sched-item-prompt" title={w.prompt}>
                  {w.prompt}
                </div>
              </div>
              <div className="sched-item-actions">
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost ui-btn-sm"
                  title="立即触发"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void triggerWorkflow(w.id)
                      .then((res) => {
                        onShowToast(res.ok ? '已触发' : res.error || '触发失败');
                        setOk(res.ok ? `已触发运行${res.runId ? ` · ${res.runId.slice(0, 8)}` : ''}` : '');
                        if (res.ok && res.sessionId) {
                          const st = useLayoutStore.getState();
                          if (!st.sessions.some((s) => s.id === res.sessionId)) {
                            st.createSession({
                              id: res.sessionId,
                              title: `定时 · ${w.name}`,
                            });
                          }
                        }
                        return refresh();
                      })
                      .catch((e) => setError(networkUserMessage(e) || '触发失败'))
                      .finally(() => setBusy(false));
                  }}
                >
                  <Lucide.Play size={16} />
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost ui-btn-sm"
                  title={w.enabled === false ? '启用' : '暂停'}
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    const enabling = w.enabled === false;
                    void updateWorkflow(w.id, { enabled: enabling })
                      .then(() => {
                        if (enabling) maybeWatchHint(`${w.name} ${w.prompt || ''}`);
                        return refresh();
                      })
                      .catch((e) => setError(networkUserMessage(e) || '更新失败'))
                      .finally(() => setBusy(false));
                  }}
                >
                  {w.enabled === false ? <Lucide.PlayCircle size={16} /> : <Lucide.Pause size={16} />}
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost ui-btn-sm"
                  title="删除"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void deleteWorkflow(w.id)
                      .then(() => {
                        onShowToast('已删除');
                        return refresh();
                      })
                      .catch((e) => setError(networkUserMessage(e) || '删除失败'))
                      .finally(() => setBusy(false));
                  }}
                >
                  <Lucide.Trash2 size={16} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {runs.length > 0 ? (
        <div className="sched-runs">
          <div className="sched-runs-h">最近运行</div>
          <ul className="sched-list sched-runs-list">
            {runs.slice(0, 12).map((r) => {
              const wfName = workflows.find((w) => w.id === r.workflowId)?.name || r.workflowId;
              const when = r.startedAt || r.scheduledFor || '';
              const whenLabel = when
                ? new Date(when).toLocaleString(undefined, {
                    month: 'numeric',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : '—';
              return (
                <li key={`${r.workflowId}-${r.runId}`} className="sched-item sched-run-item">
                  <div className="sched-item-main">
                    <div className="sched-item-name">{wfName}</div>
                    <div className="sched-item-meta">
                      {workflowRunStatusLabel(r.status)} · {whenLabel}
                      {r.error ? ` · ${r.error.slice(0, 40)}` : ''}
                    </div>
                  </div>
                  <div className="sched-item-actions">
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost ui-btn-sm"
                      title={r.sessionId ? '打开会话' : '无关联会话'}
                      disabled={!r.sessionId}
                      onClick={() => openRunSession(r)}
                    >
                      <Lucide.MessageSquare size={16} />
                    </button>
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
