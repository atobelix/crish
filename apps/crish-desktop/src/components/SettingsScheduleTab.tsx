/**
 * 设置 · 定时任务（design system v2）：引擎 workflow 列表 / 创建 / 启停 / 触发 / 删除
 */
import React, { useEffect, useMemo, useState } from 'react';
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

type ScheduleFilter = 'all' | 'enabled' | 'paused' | 'manual' | 'timed';

const FILTER_OPTIONS: { id: ScheduleFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'enabled', label: '启用' },
  { id: 'paused', label: '暂停' },
  { id: 'manual', label: '手动' },
  { id: 'timed', label: '定时' },
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

function promptSnippet(prompt: unknown, max = 120): string {
  const t = String(prompt || '').trim();
  if (!t) return '';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export const SettingsScheduleTab: React.FC<Props> = ({ onShowToast: _onShowToast }) => {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [workflowsLoading, setWorkflowsLoading] = useState(false);
  const [wfBusy, setWfBusy] = useState(false);
  const [wfError, setWfError] = useState('');
  const [wfOk, setWfOk] = useState('');
  const [showWfForm, setShowWfForm] = useState(false);
  const [filter, setFilter] = useState<ScheduleFilter>('all');
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

  const stats = useMemo(() => {
    const total = workflows.length;
    const enabled = workflows.filter((w) => w.enabled !== false).length;
    const disabled = total - enabled;
    return { total, enabled, disabled };
  }, [workflows]);

  const filtered = useMemo(
    () => workflows.filter((w) => matchesFilter(w, filter)),
    [workflows, filter],
  );

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

  const resetDraft = () => {
    setWfDraft({
      name: '',
      prompt: '',
      scheduleType: 'manual',
      dailyTime: '09:00',
      intervalMinutes: '30',
    });
  };

  const handleCreate = async () => {
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
    resetDraft();
    await refreshWorkflows();
  };

  const handleToggle = async (w: WorkflowDefinition) => {
    setWfBusy(true);
    setWfError('');
    const res = await updateWorkflow(w.id, { enabled: w.enabled === false });
    setWfBusy(false);
    if (!res.ok) {
      setWfError('更新失败');
      return;
    }
    setWfOk(w.enabled === false ? '已启用' : '已暂停');
    await refreshWorkflows();
  };

  const handleTrigger = async (w: WorkflowDefinition) => {
    setWfBusy(true);
    setWfError('');
    const res = await triggerWorkflow(w.id);
    setWfBusy(false);
    if (!res.ok) {
      setWfError('触发失败');
      return;
    }
    setWfOk('已触发执行');
  };

  const handleDelete = async (w: WorkflowDefinition) => {
    setWfBusy(true);
    setWfError('');
    const res = await deleteWorkflow(w.id);
    setWfBusy(false);
    if (!res.ok) {
      setWfError('删除失败');
      return;
    }
    setWfOk('已删除');
    await refreshWorkflows();
  };

  return (
    <div className="settings-pane settings-pane--modern">
      <header className="settings-page-head">
        <h2 className="settings-page-title">定时任务</h2>
        <p className="settings-page-desc">
          主入口在侧栏「定时任务」（主对话区展示）。此处为完整管理：创建、筛选、启停与立即触发引擎
          workflow（手动 / 每天 / 间隔）。
        </p>
      </header>

      {(workflowsLoading || wfError || wfOk) && (
        <div className="settings-feature" aria-live="polite">
          {workflowsLoading && (
            <div className="settings-list-sub">正在读取引擎计划…</div>
          )}
          {wfError ? (
            <div className="settings-list-sub" role="alert">
              {wfError}
            </div>
          ) : null}
          {wfOk && !wfError ? (
            <div className="settings-list-sub">{wfOk}</div>
          ) : null}
        </div>
      )}

      <section className="settings-group" aria-label="概览">
        <div className="settings-group-label">概览</div>
        <div className="settings-list">
          <div className="settings-list-row">
            <div className="settings-list-copy">
              <div className="settings-list-title">任务统计</div>
              <div className="settings-list-sub">
                共 {stats.total} 条 · 启用 {stats.enabled} · 暂停 {stats.disabled}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group" aria-label="筛选与新建">
        <div className="settings-group-label">计划</div>
        <div className="settings-list">
          <div className="settings-list-row settings-list-row--stack">
            <div className="settings-list-copy">
              <div className="settings-list-title">筛选</div>
              <div className="settings-list-sub">按状态或调度类型过滤下方列表</div>
            </div>
            <div className="settings-list-stack-controls">
              <div className="settings-list-stack-actions">
                <div className="ui-segment ui-segment--inline settings-segment-pill">
                  {FILTER_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      className={`ui-segment-item ${filter === opt.id ? 'active' : ''}`}
                      onClick={() => setFilter(opt.id)}
                    >
                      {opt.label}
                    </button>
                  ))}
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
            </div>
          </div>
        </div>
      </section>

      {showWfForm && (
        <section className="settings-group" aria-label="新建计划">
          <div className="settings-feature">
            <div className="settings-feature-title">新建计划</div>
            <div className="settings-feature-body">
              填写名称与提示词；到点后引擎会按此 prompt 启动一轮对话。
            </div>
            <div className="settings-list">
              <div className="settings-list-row settings-list-row--stack">
                <div className="settings-list-copy">
                  <div className="settings-list-title">名称</div>
                </div>
                <div className="settings-list-stack-controls">
                  <input
                    className="settings-field-input"
                    placeholder="例如 每日代码体检"
                    value={wfDraft.name}
                    onChange={(e) => setWfDraft((d) => ({ ...d, name: e.target.value }))}
                  />
                </div>
              </div>
              <div className="settings-list-row settings-list-row--stack">
                <div className="settings-list-copy">
                  <div className="settings-list-title">提示词</div>
                </div>
                <div className="settings-list-stack-controls">
                  <textarea
                    className="settings-field-input"
                    rows={3}
                    placeholder="任务提示词：引擎到点会按此 prompt 启动一轮对话"
                    value={wfDraft.prompt}
                    onChange={(e) => setWfDraft((d) => ({ ...d, prompt: e.target.value }))}
                  />
                </div>
              </div>
              <div className="settings-list-row settings-list-row--stack">
                <div className="settings-list-copy">
                  <div className="settings-list-title">调度</div>
                  <div className="settings-list-sub">手动触发，或按每天 / 间隔分钟自动执行</div>
                </div>
                <div className="settings-list-stack-controls">
                  <div className="settings-list-stack-actions">
                    <select
                      className="settings-field-input"
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
                        type="time"
                        value={wfDraft.dailyTime}
                        onChange={(e) => setWfDraft((d) => ({ ...d, dailyTime: e.target.value }))}
                      />
                    )}
                    {wfDraft.scheduleType === 'intervalMinutes' && (
                      <input
                        className="settings-field-input"
                        inputMode="numeric"
                        placeholder="分钟"
                        value={wfDraft.intervalMinutes}
                        onChange={(e) =>
                          setWfDraft((d) => ({ ...d, intervalMinutes: e.target.value }))
                        }
                      />
                    )}
                  </div>
                </div>
              </div>
            </div>
            <div className="settings-feature-actions">
              <button
                type="button"
                className="ui-btn ui-btn-ghost ui-btn-sm"
                onClick={() => {
                  setShowWfForm(false);
                  setWfError('');
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-secondary ui-btn-sm"
                disabled={wfBusy}
                onClick={() => {
                  void handleCreate();
                }}
              >
                {wfBusy ? '创建中…' : '创建'}
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="settings-group" aria-label="任务列表">
        <div className="settings-group-label">
          {filter === 'all' ? '全部任务' : `筛选结果（${filtered.length}）`}
        </div>

        {!workflowsLoading && filtered.length === 0 ? (
          <div
            className="settings-feature"
            style={{ alignItems: 'center', textAlign: 'center', paddingTop: 28, paddingBottom: 12 }}
          >
            <Lucide.Clock size={22} strokeWidth={1.5} aria-hidden style={{ opacity: 0.35 }} />
            <div className="settings-list-title">
              {workflows.length === 0 ? '暂无计划任务' : '没有符合筛选的任务'}
            </div>
            <div className="settings-list-sub">
              {workflows.length === 0
                ? '点击「新建」创建一条引擎调度。'
                : '试试切换筛选条件，或新建一条计划。'}
            </div>
          </div>
        ) : (
          <div className="settings-list settings-list--spaced">
            {filtered.map((w) => {
              const enabled = w.enabled !== false;
              const snippet = promptSnippet(w.prompt);
              return (
                <div key={w.id} className="settings-list-row">
                  <div className="settings-list-copy">
                    <div className="settings-list-title">{w.name}</div>
                    <div className="settings-list-sub">
                      {scheduleLabel(w.schedule)}
                      {' · '}
                      {enabled ? '启用' : '暂停'}
                    </div>
                    {snippet ? <div className="settings-list-sub">{snippet}</div> : null}
                  </div>
                  <div className="settings-list-control">
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost ui-btn-sm"
                      title={enabled ? '暂停' : '启用'}
                      disabled={wfBusy}
                      onClick={() => {
                        void handleToggle(w);
                      }}
                    >
                      {enabled ? <Lucide.Pause size={16} /> : <Lucide.Play size={16} />}
                    </button>
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost ui-btn-sm"
                      title="立即执行"
                      disabled={wfBusy}
                      onClick={() => {
                        void handleTrigger(w);
                      }}
                    >
                      <Lucide.Zap size={16} />
                    </button>
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost ui-btn-sm"
                      title="删除"
                      disabled={wfBusy}
                      onClick={() => {
                        void handleDelete(w);
                      }}
                    >
                      <Lucide.Trash2 size={16} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
