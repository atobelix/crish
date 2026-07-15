import React, { useState, useEffect, useMemo } from 'react';
import * as Lucide from 'lucide-react';
import { clientApi } from '../api/clientApi';
import type { CronJob } from '../api/clientApi';
import { useLayoutStore } from '../store/layoutStore';
import { isDemoMode } from '../api/appMode';
import { getDesktopDaemonClient } from '../api/daemonClient';
import { estimateCostUsd } from '../api/pricingStore';
import { getActiveModelId } from '../api/providerProfiles';
import {
  fetchEngineLiveStatus,
  type ActiveRunInfo,
  type PendingApprovalInfo,
} from '../api/engineStatus';
import { listWorkflows, scheduleLabel, type WorkflowDefinition } from '../api/workflowApi';
import {
  getBackgroundTaskOutput,
  listBackgroundTasks,
  openBackgroundTaskInTerminal,
  type BackgroundTaskInfo,
} from '../api/backgroundTasksApi';

interface RuntimePanelProps {
  wsId: string;
  onShowToast: (msg: string) => void;
}

/**
 * 运行状态悬浮面板（正式版 H2）
 * - 引擎连接 + activeRuns / pendingApprovals（get-status）
 * - 用量：本地累计；H3 可按 runId 接 snapshot
 * - 计划：workflow 列表（H3 再补 CRUD）
 */
export const RuntimePanel: React.FC<RuntimePanelProps> = ({ wsId: _wsId, onShowToast }) => {
  const cronJobs = useLayoutStore((state) => state.scheduledTasks);
  const tokenUsage = useLayoutStore((state) => state.tokenUsage);
  const sessions = useLayoutStore((state) => state.sessions);
  const demo = isDemoMode();

  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [engineOnline, setEngineOnline] = useState(() => getDesktopDaemonClient().isConnected());
  const [activeRuns, setActiveRuns] = useState<ActiveRunInfo[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApprovalInfo[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [bgTasks, setBgTasks] = useState<BackgroundTaskInfo[]>([]);
  const [bgExpanded, setBgExpanded] = useState<string | null>(null);
  const [bgDetail, setBgDetail] = useState('');
  const [bgLoading, setBgLoading] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const client = getDesktopDaemonClient();
    setEngineOnline(client.isConnected());
    const unsub = client.onState((s) => {
      setEngineOnline(s === 'connected');
    });
    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, []);

  // 轮询引擎 live 状态 + 后台常驻任务
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const [live, bgs] = await Promise.all([
        fetchEngineLiveStatus(),
        listBackgroundTasks().catch(() => [] as BackgroundTaskInfo[]),
      ]);
      if (cancelled) return;
      setEngineOnline(live.connected);
      setActiveRuns(live.activeRuns);
      setPendingApprovals(live.pendingApprovals);
      setBgTasks(bgs);
    };
    void tick();
    const t = setInterval(() => void tick(), 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true);
        const [crons, wfs] = await Promise.all([
          clientApi.getScheduledTasks(),
          listWorkflows(),
        ]);
        useLayoutStore.getState().setScheduledTasks(crons);
        setWorkflows(wfs);
      } catch {
        if (demo) onShowToast('读取状态失败');
      } finally {
        setLoading(false);
      }
    };
    void loadData();
  }, [onShowToast, demo]);

  const liveTasks = useMemo(() => {
    const fromMessages: { id: string; taskName: string; elapsedSeconds: number }[] = [];
    for (const s of sessions) {
      for (const m of s.messages || []) {
        if (m.status === 'processing') {
          fromMessages.push({
            id: m.id,
            taskName: s.title || '对话进行中',
            elapsedSeconds: Math.max(0, Math.round((now - (m.timestamp || now)) / 1000)),
          });
        }
      }
    }
    // 合并引擎 activeRuns
    for (const r of activeRuns) {
      if (fromMessages.some((t) => t.id === r.runId)) continue;
      const started =
        typeof r.startedAt === 'number'
          ? r.startedAt
          : typeof r.startedAt === 'string'
            ? Date.parse(r.startedAt) || now
            : now;
      fromMessages.push({
        id: r.runId,
        taskName: (r.prompt || r.status || '引擎任务').slice(0, 48),
        elapsedSeconds: Math.max(0, Math.round((now - started) / 1000)),
      });
    }
    return fromMessages;
  }, [sessions, activeRuns, now]);

  const modelId = getActiveModelId() || 'unknown';
  const estimated =
    tokenUsage.cost > 0
      ? tokenUsage.cost
      : estimateCostUsd(modelId, tokenUsage.input, tokenUsage.output);

  if (loading) {
    return (
      <div className="rt-panel" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div className="loading-spinner rt-spinner" />
        <span className="rt-empty" style={{ paddingTop: 8 }}>
          加载中…
        </span>
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
      <section className="rt-section">
        <div className="rt-section-head">
          <h4 className="rt-section-title">引擎</h4>
          <span className={`rt-dot ${engineOnline ? 'on' : 'off'}`} title={engineOnline ? '已连接' : '未连接'} />
          <span className="rt-row-meta" style={{ marginLeft: 4 }}>
            {engineOnline ? '已连接' : '连接中…'}
          </span>
        </div>
      </section>

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
              <span className="rt-stat-value">{tokenUsage.input.toLocaleString()}</span>
            </div>
            <div className="rt-stat-row">
              <span className="rt-stat-label">输出</span>
              <span className="rt-stat-value">{tokenUsage.output.toLocaleString()}</span>
            </div>
            <div className="rt-stat-row is-total">
              <span className="rt-stat-label">费用估算</span>
              <span className="rt-stat-value">${estimated.toFixed(4)}</span>
            </div>
          </div>
        </div>
        {!demo && tokenUsage.input === 0 && tokenUsage.output === 0 && (
          <div className="rt-empty" style={{ paddingTop: 4 }}>
            完成对话后累计；有引擎样本时用 snapshot usage，否则字数估算
          </div>
        )}
      </section>

      <section className="rt-section">
        <h4 className="rt-section-title">活动任务</h4>
        {liveTasks.length === 0 ? (
          <div className="rt-empty">当前没有进行中的任务</div>
        ) : (
          <div className="rt-list">
            {liveTasks.map((wk) => (
              <div key={wk.id} className="rt-row">
                <div className="rt-row-main">
                  <div className="loading-spinner rt-spinner" />
                  <div className="rt-row-text">
                    <span className="rt-row-title">{wk.taskName}</span>
                    <span className="rt-row-meta">已运行 {wk.elapsedSeconds} 秒</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rt-section">
        <h4 className="rt-section-title">后台常驻</h4>
        {bgTasks.length === 0 ? (
          <div className="rt-empty">无后台任务 · 长驻进程会列在此处</div>
        ) : (
          <div className="rt-list">
            {bgTasks.map((t) => (
              <div key={t.id}>
                <div
                  className="rt-row is-clickable"
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    void (async () => {
                      if (bgExpanded === t.id) {
                        setBgExpanded(null);
                        setBgDetail('');
                        return;
                      }
                      setBgExpanded(t.id);
                      setBgLoading(true);
                      try {
                        const out = await getBackgroundTaskOutput(t.id);
                        setBgDetail(out || t.summary || t.command || '（无输出）');
                      } catch {
                        setBgDetail(t.summary || t.command || '读取失败');
                      } finally {
                        setBgLoading(false);
                      }
                    })();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.currentTarget as HTMLElement).click();
                  }}
                >
                  <div className="rt-row-main">
                    <Lucide.Server size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                    <div className="rt-row-text">
                      <span className="rt-row-title">{t.label}</span>
                      <span className="rt-row-meta">
                        {t.state}
                        {t.command ? ` · ${t.command.slice(0, 40)}` : ''}
                      </span>
                    </div>
                  </div>
                </div>
                {bgExpanded === t.id ? (
                  <div className="rt-bg-detail">
                    {bgLoading ? '加载中…' : bgDetail}
                    {!bgLoading ? (
                      <div style={{ marginTop: 8 }}>
                        <button
                          type="button"
                          className="ui-btn ui-btn-ghost ui-btn-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            openBackgroundTaskInTerminal(t.label, bgDetail);
                            onShowToast('已在终端面板打开详情');
                          }}
                        >
                          在终端中打开
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      {pendingApprovals.length > 0 && (
        <section className="rt-section">
          <h4 className="rt-section-title">待确认</h4>
          <div className="rt-list">
            {pendingApprovals.map((a, i) => (
              <div key={a.toolCallId || i} className="rt-row">
                <div className="rt-row-main">
                  <Lucide.Shield size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                  <div className="rt-row-text">
                    <span className="rt-row-title">{a.toolName || '工具'}</span>
                    <span className="rt-row-meta">{a.summary || a.toolCallId || '等待批准'}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="rt-section">
        <div className="rt-section-head">
          <h4 className="rt-section-title">计划任务</h4>
          <button
            type="button"
            className="ui-btn ui-btn-ghost ui-btn-sm"
            onClick={() => useLayoutStore.getState().openSettings('schedule')}
          >
            设置中管理
          </button>
        </div>
        {workflows.length === 0 && cronJobs.length === 0 ? (
          <div className="rt-empty">暂无计划任务 · 引擎 workflow 就绪后会出现在此</div>
        ) : (
          <div className="rt-list" style={{ gap: 8 }}>
            {workflows.map((w) => (
              <div key={w.id} className="rt-cron-card">
                <div className="rt-cron-top">
                  <div className="rt-cron-left">
                    <span className={`rt-dot ${w.enabled !== false ? 'on' : 'off'}`} />
                    <span className="rt-cron-expr">{scheduleLabel(w.schedule)}</span>
                  </div>
                </div>
                <div className="rt-cron-prompt">{w.name}</div>
                {w.prompt && (
                  <div className="rt-cron-next" style={{ opacity: 0.8 }}>
                    {(w.prompt as string).slice(0, 80)}
                  </div>
                )}
              </div>
            ))}
            {cronJobs.map((job: CronJob) => (
              <div key={job.id} className="rt-cron-card">
                <div className="rt-cron-top">
                  <div className="rt-cron-left">
                    <span className={`rt-dot ${job.status === 'active' ? 'on' : 'off'}`} />
                    <span className="rt-cron-expr">{job.cronExpression}</span>
                  </div>
                </div>
                <div className="rt-cron-prompt">{job.prompt}</div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
