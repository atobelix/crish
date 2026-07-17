import React, { useState, useEffect, useMemo } from 'react';
import * as Lucide from 'lucide-react';
import type { CronJob } from '../api/clientApi';
import { useLayoutStore } from '../store/layoutStore';
import { clearAgentPanelFocus } from '../api/openAgentPanel';
import {
  setActiveSessionId,
  setScheduledTasks,
} from '../api/storeAccess';
import { getDesktopDaemonClient } from '../api/daemonClient';
import { estimateCostUsd } from '../api/pricingStore';
import { getActiveModelId, resolveDisplayModelId } from '../api/providerProfiles';
import {
  fetchEngineLiveStatus,
  type ActiveRunInfo,
  type PendingApprovalInfo,
} from '../api/engineStatus';
import { listWorkflows, scheduleLabel, type WorkflowDefinition } from '../api/workflowApi';
import {
  BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER,
  backgroundTaskStateLabel,
  getBackgroundTaskOutput,
  listBackgroundTasks,
  openBackgroundTaskInTerminal,
  type BackgroundTaskInfo,
} from '../api/backgroundTasksApi';
import { daemonApproveTool, daemonDenyTool } from '../api/daemonChatBridge';
import { emitUiEvent } from '../api/uiEvents';

interface RuntimePanelProps {
  wsId: string;
  onShowToast: (msg: string) => void;
}

// ── 纯展示辅助（中文 / 空态 / a11y；无副作用） ─────────────────────────

/** 引擎连接短标签（状态点旁） */
export function formatEngineStatusShort(online: boolean): string {
  return online ? '就绪' : '未就绪';
}

/** 引擎连接完整 aria / title */
export function formatEngineStatusFull(online: boolean): string {
  return online ? '引擎就绪' : '引擎未就绪';
}

/** 引擎 title 补充说明 */
export function formatEngineStatusTitle(online: boolean): string {
  return online
    ? '引擎已连接，可接收任务'
    : '引擎未连接；活动任务与计划可能不完整';
}

/** 活动任务空态：离线与空列表分流 */
export function emptyLiveTasksHint(online: boolean): string {
  return online ? '暂无进行中的任务' : '未连接';
}

/** 后台任务空态 */
export function emptyBgTasksHint(online: boolean): string {
  return online ? '暂无后台任务' : '未连接';
}

/** 计划任务空态 */
export function emptyPlansHint(online: boolean): string {
  return online ? '暂无计划' : '未连接';
}

/** 区段计数（0 不显示，避免空数字噪音） */
export function formatSectionCount(n: number): string | null {
  const c = Math.max(0, n | 0);
  return c > 0 ? String(c) : null;
}

/** 已运行时长中文 */
export function formatElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m} 分 ${r} 秒`;
  const h = Math.floor(m / 60);
  return `${h} 时 ${m % 60} 分`;
}

/** 活动行 aria-label */
export function liveTaskAriaLabel(opts: {
  taskName: string;
  elapsedSeconds: number;
  hasSession: boolean;
}): string {
  const name = (opts.taskName || '引擎任务').trim() || '引擎任务';
  const elapsed = formatElapsed(opts.elapsedSeconds);
  const open = opts.hasSession ? '，点击打开对应会话' : '';
  return `${name}，已运行 ${elapsed}${open}`;
}

/** 后台行 meta：中文状态 + 可选命令摘要 */
export function formatBgTaskMeta(opts: {
  state: unknown;
  command?: string;
  opening?: boolean;
}): string {
  if (opts.opening) return '打开中…';
  const label = backgroundTaskStateLabel(opts.state);
  const cmd = (opts.command || '').trim();
  if (!cmd) return label;
  return `${label} · ${cmd.slice(0, 40)}`;
}

/** 用量环 aria */
export function formatUsageRingAria(tokenPercent: number): string {
  const p = Math.max(0, Math.min(100, tokenPercent | 0));
  return `上下文占用约 ${p}%`;
}

/**
 * 运行状态悬浮面板（正式版 H2）
 * - 引擎连接 + activeRuns / pendingApprovals（get-status）
 * - 用量：本地累计；H3 可按 runId 接 snapshot
 * - 计划：workflow 列表（H3 再补 CRUD）
 * - 成功操作静默（列表/面板切换即反馈）；仅失败 toast
 */
export const RuntimePanel: React.FC<RuntimePanelProps> = ({ wsId: _wsId, onShowToast }) => {
  const cronJobs = useLayoutStore((state) => state.scheduledTasks);
  const tokenUsage = useLayoutStore((state) => state.tokenUsage);
  const sessions = useLayoutStore((state) => state.sessions);

  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [engineOnline, setEngineOnline] = useState(() => getDesktopDaemonClient().isConnected());
  const [activeRuns, setActiveRuns] = useState<ActiveRunInfo[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApprovalInfo[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [bgTasks, setBgTasks] = useState<BackgroundTaskInfo[]>([]);
  const [bgOpeningId, setBgOpeningId] = useState<string | null>(null);
  /** 审批按钮防连点；成功静默，仅失败 toast */
  const [approvalBusyId, setApprovalBusyId] = useState<string | null>(null);

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
        // 正式：仅引擎 workflow；不再混入 localStorage 假 cron
        const wfs = await listWorkflows();
        setWorkflows(wfs);
        setScheduledTasks([]);
        // 成功/空列表静默（打开面板不 toast）
      } catch {
        // 仅错误 toast
        onShowToast('读取运行状态失败');
      } finally {
        setLoading(false);
      }
    };
    void loadData();
  }, [onShowToast]);

  type LiveTask = {
    id: string;
    taskName: string;
    elapsedSeconds: number;
    sessionId?: string;
    kind: 'session' | 'run';
  };

  const liveTasks = useMemo(() => {
    const fromMessages: LiveTask[] = [];
    for (const s of sessions) {
      for (const m of s.messages || []) {
        if (m.status === 'processing') {
          fromMessages.push({
            id: m.id,
            taskName: s.title || '对话进行中',
            elapsedSeconds: Math.max(0, Math.round((now - (m.timestamp || now)) / 1000)),
            sessionId: s.id,
            kind: 'session',
          });
        }
      }
    }
    // 合并引擎 activeRuns（不用英文 status 作标题）
    for (const r of activeRuns) {
      if (fromMessages.some((t) => t.id === r.runId)) continue;
      const started =
        typeof r.startedAt === 'number'
          ? r.startedAt
          : typeof r.startedAt === 'string'
            ? Date.parse(r.startedAt) || now
            : now;
      const matched = sessions.find(
        (s) => s.engineLastRunId === r.runId || s.id === r.sessionId,
      );
      const rawName = (matched?.title || r.prompt || '').trim();
      fromMessages.push({
        id: r.runId,
        taskName: (rawName || '引擎任务').slice(0, 48),
        elapsedSeconds: Math.max(0, Math.round((now - started) / 1000)),
        sessionId: matched?.id || r.sessionId,
        kind: 'run',
      });
    }
    return fromMessages;
  }, [sessions, activeRuns, now]);

  const planCount = workflows.length + cronJobs.length;
  const liveCountLabel = formatSectionCount(liveTasks.length);
  const bgCountLabel = formatSectionCount(bgTasks.length);
  const planCountLabel = formatSectionCount(planCount);
  const approvalCountLabel = formatSectionCount(pendingApprovals.length);

  const focusSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
    clearAgentPanelFocus();
    try {
      window.dispatchEvent(new CustomEvent('crish-focus-chat', { detail: { sessionId } }));
    } catch {
      /* ignore */
    }
  };

  const handleLiveTaskClick = (wk: LiveTask) => {
    if (!wk.sessionId) return;
    focusSession(wk.sessionId);
  };

  const handleApprovalClick = (a: PendingApprovalInfo) => {
    const toolCallId = a.toolCallId;
    let found = toolCallId
      ? sessions.find(
          (s) =>
            (s.messages || []).some((m) =>
              (m.toolCalls || []).some(
                (tc) => tc.id === toolCallId && tc.status === 'pending_approval',
              ),
            ) ||
            (s.agents || []).some((ag) =>
              (ag.messages || []).some((m) =>
                (m.toolCalls || []).some(
                  (tc) => tc.id === toolCallId && tc.status === 'pending_approval',
                ),
              ),
            ),
        )
      : undefined;
    if (!found && a.runId) {
      found = sessions.find(
        (s) => s.engineLastRunId === a.runId || s.id === a.runId,
      );
    }
    if (found) {
      focusSession(found.id);
    } else {
      onShowToast('未找到待确认会话');
    }
  };

  const markLocalTool = (
    toolCallId: string | undefined,
    status: 'running' | 'error',
    output: string,
  ) => {
    if (!toolCallId) return;
    useLayoutStore.setState((state) => {
      for (const s of state.sessions) {
        for (const m of s.messages || []) {
          const tc = m.toolCalls?.find((t) => t.id === toolCallId);
          if (tc) {
            tc.status = status;
            tc.output = output;
          }
        }
        for (const ag of s.agents || []) {
          for (const m of ag.messages || []) {
            const tc = m.toolCalls?.find((t) => t.id === toolCallId);
            if (tc) {
              tc.status = status;
              tc.output = output;
            }
          }
        }
      }
    });
  };

  const handleApprovalAllow = (a: PendingApprovalInfo, e: React.MouseEvent) => {
    e.stopPropagation();
    const id = a.toolCallId;
    if (!id) {
      onShowToast('缺少工具 id，无法批准');
      return;
    }
    if (approvalBusyId) return;
    setApprovalBusyId(id);
    markLocalTool(id, 'running', '执行中…');
    // 成功静默（列表移除即反馈）；仅发送失败 toast
    void daemonApproveTool(id)
      .then(() => {
        setPendingApprovals((prev) => prev.filter((x) => x.toolCallId !== id));
      })
      .catch(() => {
        markLocalTool(id, 'error', '批准失败');
        onShowToast('批准失败，请重试');
      })
      .finally(() => {
        setApprovalBusyId(null);
      });
  };

  const handleApprovalDeny = (a: PendingApprovalInfo, e: React.MouseEvent) => {
    e.stopPropagation();
    const id = a.toolCallId;
    if (!id) {
      onShowToast('缺少工具 id，无法拒绝');
      return;
    }
    if (approvalBusyId) return;
    setApprovalBusyId(id);
    markLocalTool(id, 'error', '已拒绝');
    void daemonDenyTool(id)
      .then(() => {
        setPendingApprovals((prev) => prev.filter((x) => x.toolCallId !== id));
      })
      .catch(() => {
        onShowToast('拒绝失败，请重试');
      })
      .finally(() => {
        setApprovalBusyId(null);
      });
  };

  const openBgTask = async (t: BackgroundTaskInfo) => {
    if (bgOpeningId) return;
    setBgOpeningId(t.id);
    try {
      const out = await getBackgroundTaskOutput(t.id);
      // 打开终端是可预期操作：不 toast；面板切换即反馈
      openBackgroundTaskInTerminal(
        t.label,
        out || t.summary || t.command || BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER,
      );
    } catch {
      // 仅错误提示；仍尽量打开终端展示回退内容
      openBackgroundTaskInTerminal(
        t.label,
        t.summary || t.command || '读取失败',
      );
      onShowToast('读取后台任务输出失败');
    } finally {
      setBgOpeningId(null);
    }
  };

  const modelId = resolveDisplayModelId() || getActiveModelId() || 'unknown';
  const estimated =
    tokenUsage.cost > 0
      ? tokenUsage.cost
      : estimateCostUsd(modelId, tokenUsage.input, tokenUsage.output);

  if (loading) {
    return (
      <div
        className="rt-panel is-loading"
        role="status"
        aria-busy="true"
        aria-label="加载运行状态"
      >
        <div className="loading-spinner rt-spinner" aria-hidden />
        <span className="rt-empty rt-empty--tight">加载中…</span>
      </div>
    );
  }

  const tokenPercent = Math.min(
    100,
    Math.max(0, Math.round((tokenUsage.input / (tokenUsage.inputMax || 160000)) * 100)),
  );
  const engineFull = formatEngineStatusFull(engineOnline);
  const engineShort = formatEngineStatusShort(engineOnline);
  const engineTitle = formatEngineStatusTitle(engineOnline);

  return (
    <div className="rt-panel" role="region" aria-label="运行状态">
      {/* 引擎状态已在 float header 展示；面板内仅一行精简状态 */}
      <section className="rt-section rt-section--engine" aria-labelledby="rt-sec-engine">
        <div className="rt-section-head">
          <h4 id="rt-sec-engine" className="rt-section-title">
            引擎
          </h4>
          <div
            className="rt-engine-status"
            role="status"
            aria-live="polite"
            aria-label={engineFull}
            title={engineTitle}
          >
            <span className={`rt-dot ${engineOnline ? 'on' : 'off'}`} aria-hidden />
            <span className="rt-row-meta rt-engine-meta">{engineShort}</span>
          </div>
        </div>
      </section>

      <section className="rt-section rt-section--usage" aria-labelledby="rt-sec-usage">
        <div className="rt-section-head">
          <h4 id="rt-sec-usage" className="rt-section-title">
            用量
          </h4>
          <span className="rt-row-meta" aria-label={formatUsageRingAria(tokenPercent)}>
            {tokenPercent}%
          </span>
        </div>
        <div className="rt-usage rt-usage--compact">
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
              <span className="rt-stat-label">费用</span>
              <span className="rt-stat-value">${estimated.toFixed(4)}</span>
            </div>
          </div>
        </div>
      </section>

      <section className="rt-section" aria-labelledby="rt-sec-live">
        <div className="rt-section-head">
          <h4 id="rt-sec-live" className="rt-section-title">
            活动任务
          </h4>
          {liveCountLabel ? (
            <span className="rt-row-meta" aria-live="polite" aria-label={`${liveCountLabel} 个进行中`}>
              {liveCountLabel}
            </span>
          ) : null}
        </div>
        {liveTasks.length === 0 ? (
          <div className="rt-empty" role="status">
            {emptyLiveTasksHint(engineOnline)}
          </div>
        ) : (
          <div
            className={`rt-list${liveTasks.length > 4 ? ' rt-list--scroll' : ''}`}
            role="list"
            aria-label="进行中的任务"
          >
            {liveTasks.map((wk) => {
              const elapsedText = formatElapsed(wk.elapsedSeconds);
              const clickable = Boolean(wk.sessionId);
              return (
                <div
                  key={wk.id}
                  className={`rt-row is-live${clickable ? ' is-clickable' : ''}`}
                  role={clickable ? 'button' : 'listitem'}
                  tabIndex={clickable ? 0 : undefined}
                  title={clickable ? '打开对应会话' : undefined}
                  aria-label={liveTaskAriaLabel({
                    taskName: wk.taskName,
                    elapsedSeconds: wk.elapsedSeconds,
                    hasSession: clickable,
                  })}
                  onClick={() => {
                    if (wk.sessionId) handleLiveTaskClick(wk);
                  }}
                  onKeyDown={(e) => {
                    if (!wk.sessionId) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleLiveTaskClick(wk);
                    }
                  }}
                >
                  <div className="rt-row-main">
                    <div className="loading-spinner rt-spinner" aria-hidden />
                    <div className="rt-row-text">
                      <span className="rt-row-title">{wk.taskName}</span>
                      <span className="rt-row-meta">已运行 {elapsedText}</span>
                    </div>
                  </div>
                  {clickable ? (
                    <Lucide.ChevronRight size={16} className="rt-row-chevron" aria-hidden />
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="rt-section" aria-labelledby="rt-sec-bg">
        <div className="rt-section-head">
          <h4 id="rt-sec-bg" className="rt-section-title">
            后台常驻
          </h4>
          {bgCountLabel ? (
            <span className="rt-row-meta" aria-live="polite" aria-label={`${bgCountLabel} 个后台任务`}>
              {bgCountLabel}
            </span>
          ) : null}
        </div>
        {bgTasks.length === 0 ? (
          <div className="rt-empty" role="status">
            {emptyBgTasksHint(engineOnline)}
          </div>
        ) : (
          <div
            className={`rt-list${bgTasks.length > 4 ? ' rt-list--scroll' : ''}`}
            role="list"
            aria-label="后台常驻任务"
          >
            {bgTasks.map((t) => {
              const opening = bgOpeningId === t.id;
              const stateZh = backgroundTaskStateLabel(t.state);
              const meta = formatBgTaskMeta({
                state: t.state,
                command: t.command,
                opening,
              });
              return (
                <div
                  key={t.id}
                  className={`rt-row is-clickable${opening ? ' is-opening' : ''}`}
                  role="button"
                  tabIndex={0}
                  title="在终端中查看输出"
                  aria-label={`${t.label}，${stateZh}，在终端中查看输出`}
                  aria-busy={opening || undefined}
                  onClick={() => {
                    void openBgTask(t);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      void openBgTask(t);
                    }
                  }}
                >
                  <div className="rt-row-main">
                    <Lucide.Terminal size={16} className="rt-row-ico" aria-hidden />
                    <div className="rt-row-text">
                      <span className="rt-row-title">{t.label}</span>
                      <span className="rt-row-meta">{meta}</span>
                    </div>
                  </div>
                  <Lucide.ChevronRight size={16} className="rt-row-chevron" aria-hidden />
                </div>
              );
            })}
          </div>
        )}
      </section>

      {pendingApprovals.length > 0 && (
        <section className="rt-section" aria-labelledby="rt-sec-approve">
          <div className="rt-section-head">
            <h4 id="rt-sec-approve" className="rt-section-title">
              待确认
            </h4>
            {approvalCountLabel ? (
              <span
                className="rt-row-meta"
                aria-live="polite"
                aria-label={`${approvalCountLabel} 项待确认`}
              >
                {approvalCountLabel}
              </span>
            ) : null}
          </div>
          <div className="rt-list" role="list" aria-label="待确认工具">
            {pendingApprovals.map((a, i) => {
              const toolLabel = a.toolName || '工具';
              const busy = approvalBusyId === (a.toolCallId || '');
              return (
                <div
                  key={a.toolCallId || i}
                  className="rt-row is-clickable"
                  role="button"
                  tabIndex={0}
                  title="打开待确认会话"
                  aria-label={`${toolLabel}，等待批准，打开对应会话`}
                  onClick={() => handleApprovalClick(a)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleApprovalClick(a);
                    }
                  }}
                >
                  <div className="rt-row-main">
                    <span className="rt-dot warn" aria-hidden />
                    <div className="rt-row-text">
                      <span className="rt-row-title">{toolLabel}</span>
                      <span className="rt-row-meta">
                        {a.summary || a.toolCallId || '等待批准'}
                      </span>
                    </div>
                  </div>
                  <div
                    className="rt-row-actions"
                    role="group"
                    aria-label={`${toolLabel} 审批`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      className="ui-btn ui-btn-primary ui-btn-sm"
                      title="允许"
                      aria-label={`允许 ${toolLabel}`}
                      aria-busy={busy || undefined}
                      disabled={Boolean(approvalBusyId)}
                      onClick={(e) => handleApprovalAllow(a, e)}
                    >
                      {busy ? '…' : '允许'}
                    </button>
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost ui-btn-sm"
                      title="拒绝"
                      aria-label={`拒绝 ${toolLabel}`}
                      disabled={Boolean(approvalBusyId)}
                      onClick={(e) => handleApprovalDeny(a, e)}
                    >
                      拒绝
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="rt-section" aria-labelledby="rt-sec-plan">
        <div className="rt-section-head">
          <h4 id="rt-sec-plan" className="rt-section-title">
            计划任务
          </h4>
          {planCountLabel ? (
            <span className="rt-row-meta" aria-live="polite" aria-label={`${planCountLabel} 个计划`}>
              {planCountLabel}
            </span>
          ) : null}
          <button
            type="button"
            className="ui-btn ui-btn-ghost ui-btn-sm"
            aria-label="管理计划"
            onClick={() => {
              emitUiEvent('open-scheduled');
            }}
          >
            管理
          </button>
        </div>
        {planCount === 0 ? (
          <div className="rt-empty" role="status">
            {emptyPlansHint(engineOnline)}
          </div>
        ) : (
          <div className="rt-list rt-list--scroll" role="list" aria-label="计划任务列表">
            {workflows.map((w) => {
              const enabled = w.enabled !== false;
              return (
                <div
                  key={w.id}
                  className="rt-cron-card"
                  role="listitem"
                  aria-label={`${w.name}，${enabled ? '已启用' : '已停用'}，${scheduleLabel(w.schedule)}`}
                >
                  <div className="rt-cron-top">
                    <div className="rt-cron-left">
                      <span
                        className={`rt-dot ${enabled ? 'on' : 'off'}`}
                        aria-hidden
                      />
                      <span className="rt-cron-expr">{scheduleLabel(w.schedule)}</span>
                    </div>
                  </div>
                  <div className="rt-cron-prompt">{w.name}</div>
                  {w.prompt && (
                    <div className="rt-cron-next">{(w.prompt as string).slice(0, 80)}</div>
                  )}
                </div>
              );
            })}
            {cronJobs.map((job: CronJob) => {
              const active = job.status === 'active';
              return (
                <div
                  key={job.id}
                  className="rt-cron-card"
                  role="listitem"
                  aria-label={`${job.prompt || '计划'}，${active ? '进行中' : '已停用'}，${job.cronExpression}`}
                >
                  <div className="rt-cron-top">
                    <div className="rt-cron-left">
                      <span
                        className={`rt-dot ${active ? 'on' : 'off'}`}
                        aria-hidden
                      />
                      <span className="rt-cron-expr">{job.cronExpression}</span>
                    </div>
                  </div>
                  <div className="rt-cron-prompt">{job.prompt}</div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
