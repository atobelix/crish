/**
 * 设置 · 定时任务：引擎 workflow 列表 / 创建 / 启停 / 触发 / 删除
 */
import React, { useEffect, useState } from 'react';
import * as Lucide from 'lucide-react';
import { getWorkspacePath } from '../api/projectStore';
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
};

export const SettingsScheduleTab: React.FC<Props> = ({ onShowToast: _onShowToast }) => {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [workflowsLoading, setWorkflowsLoading] = useState(false);
  const [wfBusy, setWfBusy] = useState(false);
  const [wfError, setWfError] = useState('');
  const [wfOk, setWfOk] = useState('');
  const [showWfForm, setShowWfForm] = useState(false);
  const [wfDraft, setWfDraft] = useState({
    name: '',
    prompt: '',
    scheduleType: 'manual' as 'manual' | 'daily' | 'intervalMinutes',
    dailyTime: '09:00',
    intervalMinutes: '30',
  });

  const refreshWorkflows = async () => {
    setWorkflowsLoading(true);
    try {
      setWorkflows(await listWorkflows());
    } finally {
      setWorkflowsLoading(false);
    }
  };

  useEffect(() => {
    setWorkflowsLoading(true);
    setWfError('');
    void listWorkflows()
      .then(setWorkflows)
      .finally(() => setWorkflowsLoading(false));
  }, []);

  const buildScheduleFromDraft = (): WorkflowSchedule => {
    if (wfDraft.scheduleType === 'daily') {
      return {
        type: 'daily',
        time: wfDraft.dailyTime.trim() || '09:00',
        timezone: defaultTimezone(),
      };
    }
    if (wfDraft.scheduleType === 'intervalMinutes') {
      const n = Math.max(1, Number(wfDraft.intervalMinutes) || 30);
      return { type: 'intervalMinutes', intervalMinutes: n };
    }
    return { type: 'manual' };
  };

  return (
    <>
      <div
        style={{
          marginBottom: 12,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 12,
        }}
      >
        <div>
          <h4 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>定时任务</h4>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
            主入口在侧栏「定时任务」（主对话区展示）。此处为备用管理；引擎 workflow：手动 / 每天 / 间隔。
          </p>
        </div>
        <button
          type="button"
          className="ui-btn ui-btn-secondary ui-btn-sm"
          onClick={() => {
            setShowWfForm((v) => !v);
            setWfError('');
            setWfOk('');
          }}
        >
          <Lucide.Plus size={16} />
          新建
        </button>
      </div>

      {wfError && <div className="model-picker-error" style={{ marginBottom: 8 }}>{wfError}</div>}
      {wfOk && (
        <div className="chat-soft-hint" style={{ marginBottom: 8 }}>
          <span>{wfOk}</span>
        </div>
      )}

      {showWfForm && (
        <div className="settings-card-row" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>新建计划</div>
          <input
            className="settings-field-input"
            placeholder="名称，例如 每日代码体检"
            value={wfDraft.name}
            onChange={(e) => setWfDraft((d) => ({ ...d, name: e.target.value }))}
          />
          <textarea
            className="settings-field-input"
            style={{ minHeight: 72, resize: 'vertical', fontFamily: 'inherit' }}
            placeholder="任务提示词：引擎到点会按此 prompt 启动一轮对话"
            value={wfDraft.prompt}
            onChange={(e) => setWfDraft((d) => ({ ...d, prompt: e.target.value }))}
          />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select
              className="settings-field-input"
              style={{ width: 140 }}
              value={wfDraft.scheduleType}
              onChange={(e) =>
                setWfDraft((d) => ({
                  ...d,
                  scheduleType: e.target.value as typeof d.scheduleType,
                }))
              }
            >
              <option value="manual">手动</option>
              <option value="daily">每天</option>
              <option value="intervalMinutes">间隔分钟</option>
            </select>
            {wfDraft.scheduleType === 'daily' && (
              <input
                className="settings-field-input"
                style={{ width: 100 }}
                type="time"
                value={wfDraft.dailyTime}
                onChange={(e) => setWfDraft((d) => ({ ...d, dailyTime: e.target.value }))}
              />
            )}
            {wfDraft.scheduleType === 'intervalMinutes' && (
              <input
                className="settings-field-input"
                style={{ width: 100 }}
                placeholder="分钟"
                value={wfDraft.intervalMinutes}
                onChange={(e) => setWfDraft((d) => ({ ...d, intervalMinutes: e.target.value }))}
              />
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setShowWfForm(false)}>
              取消
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm"
              disabled={wfBusy}
              onClick={async () => {
                if (!wfDraft.name.trim() || !wfDraft.prompt.trim()) {
                  setWfError('请填写名称与提示词');
                  setWfOk('');
                  return;
                }
                setWfBusy(true);
                setWfError('');
                const res = await createWorkflow({
                  name: wfDraft.name,
                  prompt: wfDraft.prompt,
                  schedule: buildScheduleFromDraft(),
                  cwd: getWorkspacePath() || undefined,
                });
                setWfBusy(false);
                if (!res.ok) {
                  setWfError(
                    res.error === 'not_connected'
                      ? networkUserMessage()
                      : '创建失败，请检查引擎是否就绪',
                  );
                  return;
                }
                setWfOk('已创建计划');
                setShowWfForm(false);
                setWfDraft({
                  name: '',
                  prompt: '',
                  scheduleType: 'manual',
                  dailyTime: '09:00',
                  intervalMinutes: '30',
                });
                await refreshWorkflows();
              }}
            >
              {wfBusy ? '创建中…' : '创建'}
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {workflowsLoading && (
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>正在读取引擎计划…</div>
        )}
        {workflows.map((w) => (
          <div key={w.id} className="settings-card-row">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{w.name}</div>
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <span className={`status-badge ${w.enabled !== false ? 'available' : 'unconfigured'}`}>
                  {w.enabled !== false ? '启用' : '关闭'}
                </span>
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost ui-btn-sm"
                  title={w.enabled === false ? '启用' : '暂停'}
                  disabled={wfBusy}
                  onClick={async () => {
                    setWfBusy(true);
                    const res = await updateWorkflow(w.id, { enabled: w.enabled === false });
                    setWfBusy(false);
                    if (!res.ok) setWfError('更新失败');
                    else {
                      setWfOk(w.enabled === false ? '已启用' : '已暂停');
                      await refreshWorkflows();
                    }
                  }}
                >
                  {w.enabled === false ? <Lucide.Play size={16} /> : <Lucide.Pause size={16} />}
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost ui-btn-sm"
                  title="立即执行"
                  disabled={wfBusy}
                  onClick={async () => {
                    setWfBusy(true);
                    const res = await triggerWorkflow(w.id);
                    setWfBusy(false);
                    if (!res.ok) setWfError('触发失败');
                    else setWfOk('已触发执行');
                  }}
                >
                  <Lucide.Zap size={16} />
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost ui-btn-sm"
                  title="删除"
                  disabled={wfBusy}
                  onClick={async () => {
                    setWfBusy(true);
                    const res = await deleteWorkflow(w.id);
                    setWfBusy(false);
                    if (!res.ok) setWfError('删除失败');
                    else {
                      setWfOk('已删除');
                      await refreshWorkflows();
                    }
                  }}
                >
                  <Lucide.Trash2 size={16} />
                </button>
              </div>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>
              {scheduleLabel(w.schedule)}
            </div>
            {w.prompt && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6, lineHeight: 1.45 }}>
                {String(w.prompt).slice(0, 160)}
                {String(w.prompt).length > 160 ? '…' : ''}
              </div>
            )}
          </div>
        ))}
        {!workflowsLoading && workflows.length === 0 && (
          <div
            className="settings-card-row"
            style={{
              textAlign: 'center',
              padding: '28px 16px',
              color: 'var(--text-tertiary)',
              fontSize: 12,
              lineHeight: 1.6,
            }}
          >
            <Lucide.Clock size={22} style={{ opacity: 0.35, marginBottom: 8 }} />
            <div>暂无计划任务</div>
            <div style={{ marginTop: 4 }}>点击右上角「新建」创建一条引擎调度。</div>
          </div>
        )}
      </div>
    </>
  );
};
