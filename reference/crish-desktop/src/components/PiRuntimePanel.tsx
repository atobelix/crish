import React, { useState, useEffect } from 'react';
import * as Lucide from 'lucide-react';
import { piClientApi } from '../api/piClientApi';
import type { CronJob } from '../api/piClientApi';
import { useLayoutStore } from '../store/layoutStore';

interface PiRuntimePanelProps {
  wsId: string;
  onShowToast: (msg: string) => void;
}

export const PiRuntimePanel: React.FC<PiRuntimePanelProps> = ({ wsId: _wsId, onShowToast }) => {
  const cronJobs = useLayoutStore((state) => state.scheduledTasks);
  const mcpServers = useLayoutStore((state) => state.mcpServers);
  const tokenUsage = useLayoutStore((state) => state.tokenUsage);
  const activeWorkers = useLayoutStore((state) => state.activeWorkers);

  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);

  const [newCronExpr, setNewCronExpr] = useState('0 9 * * 1-5');
  const [newCronPrompt, setNewCronPrompt] = useState('');
  const [newCronTarget, setNewCronTarget] = useState<'current-session' | 'new-session'>('new-session');

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true);
        const [crons, mcps] = await Promise.all([
          piClientApi.getScheduledTasks(),
          piClientApi.getMcpServers(),
        ]);
        useLayoutStore.getState().setScheduledTasks(crons);
        useLayoutStore.getState().setMcpServers(mcps);
      } catch {
        onShowToast('读取遥测状态失败');
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, [onShowToast]);

  const handleToggleCron = async (job: CronJob) => {
    try {
      const updated: CronJob = {
        ...job,
        status: job.status === 'active' ? 'paused' : 'active',
        nextRun: job.status === 'active' ? '已暂停' : '2026-06-22T09:00:00+08:00',
      };
      const list = await piClientApi.saveScheduledTask(updated);
      useLayoutStore.getState().setScheduledTasks(list);
      onShowToast(updated.status === 'active' ? '任务已启动' : '任务已暂停');
    } catch {
      onShowToast('切换任务状态失败');
    }
  };

  const handleDeleteCron = async (id: string) => {
    try {
      const filtered = await piClientApi.deleteScheduledTask(id);
      useLayoutStore.getState().setScheduledTasks(filtered);
      onShowToast('已删除定时任务');
    } catch {
      onShowToast('删除任务失败');
    }
  };

  const handleAddCron = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCronPrompt.trim()) return;

    try {
      const newTask: CronJob = {
        id: `cron-${Date.now()}`,
        cronExpression: newCronExpr.trim(),
        prompt: newCronPrompt.trim(),
        targetSession: newCronTarget,
        status: 'active',
        nextRun: '2026-06-22T09:30:00+08:00',
      };

      const list = await piClientApi.saveScheduledTask(newTask);
      useLayoutStore.getState().setScheduledTasks(list);
      setNewCronPrompt('');
      setShowAddForm(false);
      onShowToast('成功注册定时任务');
    } catch {
      onShowToast('注册定时任务失败');
    }
  };

  if (loading) {
    return (
      <div className="rt-panel" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div className="loading-spinner rt-spinner" />
        <span className="rt-empty" style={{ paddingTop: 8 }}>加载中…</span>
      </div>
    );
  }

  const tokenPercent = Math.min(
    100,
    Math.max(0, Math.round((tokenUsage.input / (tokenUsage.inputMax || 160000)) * 100)),
  );
  const dashOffset = 150 - (150 * tokenPercent) / 100;

  return (
    <div className="rt-panel">
      {/* Usage */}
      <section className="rt-section">
        <h4 className="rt-section-title">本次用量</h4>
        <div className="rt-usage">
          <div className="rt-ring">
            <svg viewBox="0 0 56 56" aria-hidden>
              <circle
                cx="28"
                cy="28"
                r="24"
                stroke="var(--bg-tertiary)"
                strokeWidth="4.5"
                fill="transparent"
              />
              <circle
                cx="28"
                cy="28"
                r="24"
                stroke="var(--accent-color)"
                strokeWidth="4.5"
                fill="transparent"
                strokeDasharray="150"
                strokeDashoffset={dashOffset}
                strokeLinecap="round"
              />
            </svg>
            <div className="rt-ring-value">{tokenPercent}%</div>
          </div>

          <div className="rt-usage-stats">
            <div className="rt-stat-row">
              <span className="rt-stat-label">输入</span>
              <span className="rt-stat-value">
                {tokenUsage.input.toLocaleString()}
                <span style={{ color: 'var(--text-tertiary)', fontWeight: 500 }}>
                  {' '}/ {tokenUsage.inputMax.toLocaleString()}
                </span>
              </span>
            </div>
            <div className="rt-stat-row">
              <span className="rt-stat-label">输出</span>
              <span className="rt-stat-value">
                {tokenUsage.output.toLocaleString()}
                <span style={{ color: 'var(--text-tertiary)', fontWeight: 500 }}>
                  {' '}/ {tokenUsage.outputMax.toLocaleString()}
                </span>
              </span>
            </div>
            <div className="rt-stat-row is-total">
              <span className="rt-stat-label">费用估算</span>
              <span className="rt-stat-value">${tokenUsage.cost.toFixed(3)}</span>
            </div>
          </div>
        </div>
      </section>

      {/* Active workers */}
      {activeWorkers.length > 0 && (
        <section className="rt-section">
          <h4 className="rt-section-title">活动任务</h4>
          <div className="rt-list">
            {activeWorkers.map((wk) => (
              <div key={wk.id} className="rt-row">
                <div className="rt-row-main">
                  <div className="loading-spinner rt-spinner" />
                  <div className="rt-row-text">
                    <span className="rt-row-title">{wk.taskName}</span>
                    <span className="rt-row-meta">已运行 {wk.elapsedSeconds} 秒</span>
                  </div>
                </div>
                <div className="rt-row-actions">
                  <button
                    type="button"
                    className="ui-btn ui-btn-ghost danger"
                    title="终止"
                    onClick={() => {
                      useLayoutStore.getState().killWorker(wk.id, wk.taskName);
                      onShowToast(`已终止: ${wk.taskName}`);
                    }}
                  >
                    <Lucide.X size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* MCP */}
      <section className="rt-section">
        <h4 className="rt-section-title">MCP</h4>
        {mcpServers.length === 0 ? (
          <div className="rt-empty">暂无连接的服务</div>
        ) : (
          <div className="rt-list">
            {mcpServers.map((srv) => (
              <div key={srv.id} className="rt-row">
                <div className="rt-row-main">
                  <span
                    className={`rt-dot ${
                      srv.status === 'connected' ? 'on' : srv.status === 'connecting' ? 'warn' : 'off'
                    }`}
                  />
                  <div className="rt-row-text">
                    <span className="rt-row-title" title={srv.name}>
                      {srv.name}
                    </span>
                    <span className="rt-row-meta">
                      {srv.status === 'connected'
                        ? `${srv.tools.length} 个工具`
                        : srv.status === 'connecting'
                          ? '连接中…'
                          : '未连接'}
                    </span>
                  </div>
                </div>
                <div className="rt-row-actions">
                  <button
                    type="button"
                    className="ui-btn ui-btn-ghost"
                    title="重启"
                    onClick={() => {
                      onShowToast(`正在重启: ${srv.name}`);
                      const list = mcpServers.map((s) =>
                        s.id === srv.id ? { ...s, status: 'connecting' as const } : s,
                      );
                      useLayoutStore.getState().setMcpServers(list);
                      setTimeout(() => {
                        const list2 = mcpServers.map((s) =>
                          s.id === srv.id ? { ...s, status: 'connected' as const } : s,
                        );
                        useLayoutStore.getState().setMcpServers(list2);
                        onShowToast(`已重新连接: ${srv.name}`);
                      }, 1200);
                    }}
                  >
                    <Lucide.RefreshCw size={12} />
                  </button>
                  <button
                    type="button"
                    className="ui-btn ui-btn-ghost danger"
                    title="关闭"
                    onClick={() => {
                      onShowToast(`已关闭: ${srv.name}`);
                      const list = mcpServers.map((s) =>
                        s.id === srv.id
                          ? { ...s, status: 'disconnected' as const, tools: [] }
                          : s,
                      );
                      useLayoutStore.getState().setMcpServers(list);
                    }}
                  >
                    <Lucide.Power size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Cron */}
      <section className="rt-section">
        <div className="rt-section-head">
          <h4 className="rt-section-title">计划任务</h4>
          {!showAddForm && (
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm"
              onClick={() => setShowAddForm(true)}
            >
              <Lucide.Plus size={13} />
              添加
            </button>
          )}
        </div>

        {cronJobs.length === 0 && !showAddForm ? (
          <div className="rt-empty">还没有计划任务</div>
        ) : (
          <div className="rt-list" style={{ gap: 8 }}>
            {cronJobs.map((job) => (
              <div key={job.id} className="rt-cron-card">
                <div className="rt-cron-top">
                  <div className="rt-cron-left">
                    <span
                      className={`rt-dot ${job.status === 'active' ? 'on' : 'off'}`}
                      title={job.status === 'active' ? '运行中' : '已暂停'}
                    />
                    <span className="rt-cron-expr">{job.cronExpression}</span>
                    <span className="ui-badge">
                      {job.targetSession === 'new-session' ? '新会话' : '当前会话'}
                    </span>
                  </div>
                  <div className="rt-row-actions" style={{ opacity: 1 }}>
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost"
                      title="立即执行"
                      onClick={() => {
                        useLayoutStore.getState().triggerCronJobNow(job.prompt);
                        onShowToast('已触发任务执行');
                      }}
                    >
                      <Lucide.Zap size={12} />
                    </button>
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost"
                      title={job.status === 'active' ? '暂停' : '启动'}
                      onClick={() => handleToggleCron(job)}
                    >
                      {job.status === 'active' ? (
                        <Lucide.Pause size={12} />
                      ) : (
                        <Lucide.Play size={12} />
                      )}
                    </button>
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost danger"
                      title="删除"
                      onClick={() => handleDeleteCron(job.id)}
                    >
                      <Lucide.Trash2 size={12} />
                    </button>
                  </div>
                </div>
                <div className="rt-cron-prompt">{job.prompt}</div>
                <div className="rt-cron-next">下次：{job.nextRun}</div>
              </div>
            ))}
          </div>
        )}

        {showAddForm && (
          <form className="rt-form" onSubmit={handleAddCron}>
            <div className="rt-form-grid">
              <input
                type="text"
                className="ui-input"
                placeholder="Cron 表达式"
                value={newCronExpr}
                onChange={(e) => setNewCronExpr(e.target.value)}
                required
              />
              <select
                className="ui-input"
                value={newCronTarget}
                onChange={(e) =>
                  setNewCronTarget(e.target.value as 'current-session' | 'new-session')
                }
              >
                <option value="new-session">新会话</option>
                <option value="current-session">当前会话</option>
              </select>
            </div>
            <input
              type="text"
              className="ui-input"
              placeholder="任务指令"
              value={newCronPrompt}
              onChange={(e) => setNewCronPrompt(e.target.value)}
              required
            />
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="ui-btn ui-btn-secondary ui-btn-sm"
                onClick={() => setShowAddForm(false)}
              >
                取消
              </button>
              <button type="submit" className="ui-btn ui-btn-primary ui-btn-sm">
                保存
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
};
