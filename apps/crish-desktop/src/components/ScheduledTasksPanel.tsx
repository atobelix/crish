/**
 * 主对话区 · 定时任务：与设置页同源 workflow API，嵌入 chat-doc-flow 展示。
 */
import React, { useEffect, useState } from 'react';
import * as Lucide from 'lucide-react';
import { networkUserMessage } from '../api/userFacingErrors';
import {
  createWorkflow,
  defaultTimezone,
  deleteWorkflow,
  listWorkflows,
  scheduleLabel,
  triggerWorkflow,
  updateWorkflow,
  type WorkflowDefinition,
  type WorkflowSchedule,
} from '../api/workflowApi';

type Props = {
  onShowToast: (msg: string) => void;
  onBackToChat: () => void;
};

export const ScheduledTasksPanel: React.FC<Props> = ({ onShowToast, onBackToChat }) => {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState({
    name: '',
    prompt: '',
    scheduleType: 'manual' as 'manual' | 'daily' | 'intervalMinutes',
    dailyTime: '09:00',
    intervalMinutes: '30',
  });

  const refresh = async () => {
    setLoading(true);
    try {
      setWorkflows(await listWorkflows());
    } catch (e) {
      setError(networkUserMessage(e) || '无法加载定时任务');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const buildSchedule = (): WorkflowSchedule => {
    if (draft.scheduleType === 'daily') {
      return {
        type: 'daily',
        time: draft.dailyTime.trim() || '09:00',
        timezone: defaultTimezone(),
      };
    }
    if (draft.scheduleType === 'intervalMinutes') {
      const n = Math.max(1, Number(draft.intervalMinutes) || 30);
      return { type: 'intervalMinutes', intervalMinutes: n };
    }
    return { type: 'manual' };
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
          <p>引擎 workflow：手动 / 每天 / 间隔。在此管理，不占用设置页主路径。</p>
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
                  scheduleType: e.target.value as typeof draft.scheduleType,
                }))
              }
            >
              <option value="manual">手动</option>
              <option value="daily">每天</option>
              <option value="intervalMinutes">间隔（分钟）</option>
            </select>
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
                  schedule: buildSchedule(),
                  enabled: true,
                })
                  .then(() => {
                    setOk('已创建');
                    setShowForm(false);
                    setDraft({
                      name: '',
                      prompt: '',
                      scheduleType: 'manual',
                      dailyTime: '09:00',
                      intervalMinutes: '30',
                    });
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
          <div className="sched-empty-sub">创建可新建，或让助手在对话中帮你配置 workflow。</div>
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
                      .then(() => {
                        onShowToast('已触发');
                        setOk('已触发运行');
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
                    void updateWorkflow(w.id, { enabled: w.enabled === false })
                      .then(() => refresh())
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
    </div>
  );
};
