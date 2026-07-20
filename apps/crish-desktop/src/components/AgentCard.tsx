/**
 * 协作体「聊天」侧栏：时间线 + 可交互输入（运行中 steer / 结束后新 run 续聊）。
 * 标签名「聊天」；列表/入口在总览或主对话，勿从 + 菜单随意添加。
 * 契约：仅侧栏展示；打开/切换一律 openAgentInSidePanel / browseAgentSidePanel，
 * 永不覆盖主对话、不 spawn 主会话 ghost。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './AgentCard.module.css';
import { Tooltip } from './settings/SettingsUI';
import * as Lucide from 'lucide-react';
import { browseAgentSidePanel, openAgentInSidePanel } from '../api/openAgentPanel';
import { useLayoutStore } from '../store/layoutStore';
import type { SessionAgent, SessionMessage, FileDiff } from '../store/layoutStore';
import { focusOrOpenPanel, setActiveDiffSource as setActiveDiffSourceAccess } from '../api/storeAccess';
import { openFileInPanel } from '../api/workspaceFsApi';
import { ChatUserMessageRow, ChatAssistantMessageRow } from './ChatMessageRow';
import {
  getSessionAgent,
  selectActiveSessionId,
  selectPanelAgentId,
  selectSessionsById,
  useSessionField,
} from '../store/sessionStore';
import { buildAssistantTimeline } from '../api/toolPresentation';
import { parseMarkdownToHtml, stripThoughtPlaceholders } from '../api/markdownRender';
import { resolveToolDiffs, sanitizeToolDisplayOutput } from '../api/toolFeedback';
import { publishToolDiffs } from '../api/publishToolDiffs';
import {
  getSubagentStatus,
  sendToSubagent,
  streamCollaboratorRun,
} from '../api/subagentApi';
import { getWorkspacePath } from '../api/projectStore';
import { ComposerField } from './ChatComposer';
import { ChatToolStack } from './ChatToolCallBlock';
import { AgentTeamBoard } from './AgentTeamBoard';
import { useAgentToolApproval } from '../hooks/useAgentToolApproval';

/** 状态芯片文案（中文唯一来源） */
const STATUS_LABEL: Record<SessionAgent['status'], string> = {
  running: '运行中',
  completed: '完成',
  failed: '失败',
  stopped: '已停止',
};

/** 浏览列表排序：运行中 → 失败 → 已停止 → 完成；同组新在前 */
function rankAgentStatus(st: SessionAgent['status']): number {
  if (st === 'running') return 0;
  if (st === 'failed') return 1;
  if (st === 'stopped') return 2;
  return 3;
}

function sortAgentsForBrowse(agents: SessionAgent[]): SessionAgent[] {
  return [...agents].sort((a, b) => {
    const d = rankAgentStatus(a.status) - rankAgentStatus(b.status);
    if (d !== 0) return d;
    return (b.startedAt || 0) - (a.startedAt || 0);
  });
}

/** 紧凑时长：侧栏密度用 */
function formatAgentDuration(agent: SessionAgent): string | null {
  const start = agent.startedAt;
  if (!start || !Number.isFinite(start)) return null;
  const end = agent.endedAt && Number.isFinite(agent.endedAt) ? agent.endedAt : Date.now();
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s > 0 ? `${m} 分 ${s} 秒` : `${m} 分钟`;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

function agentDisplayName(agent: SessionAgent): string {
  return (agent.description || agent.mode || agent.id || '子智能体').trim() || '子智能体';
}

function countPendingApprovals(agent: SessionAgent): number {
  let n = 0;
  for (const m of agent.messages || []) {
    for (const t of m.toolCalls || []) {
      if (t.status === 'pending_approval') n += 1;
    }
  }
  return n;
}

/** 状态芯片：统一中文 + a11y role/status */
function AgentStatusChip({
  status,
  mode,
  compact,
}: {
  status: SessionAgent['status'];
  mode?: string;
  /** 列表行更紧时不读冗长 title */
  compact?: boolean;
}) {
  const label = STATUS_LABEL[status] || '未知';
  const modeHint = mode ? `模式：${mode}` : undefined;
  return (
    <span
      className={`${styles.agentCardBadge} ${styles['agentCardBadge' + status.charAt(0).toUpperCase() + status.slice(1)] || ''}`}
      role="status"
      data-agent-status={status}
      aria-label={`状态：${label}${mode ? `，${modeHint}` : ''}`}
      title={compact ? label : modeHint || label}
    >
      {label}
    </span>
  );
}

/**
 * Agent 侧栏空态 / 浏览列表：仅浏览本会话已有、由主 AI 拉起的子 agent。
 * 无「人类协作任务」表单；创建只发生在 run_subagent。
 * 打开详情仅 openAgentInSidePanel（侧栏 only）。
 */
function AgentBrowsePad({
  parentSessionId,
  onClose,
  embedded,
}: {
  parentSessionId?: string | null;
  onClose?: () => void;
  embedded?: boolean;
}) {
  const sessionsById = useSessionField(selectSessionsById);
  const activeSessionId = useSessionField(selectActiveSessionId);
  const parentId = parentSessionId || activeSessionId;
  const parent = parentId ? sessionsById[parentId] : undefined;
  const agents = parent?.agents || [];
  const sorted = useMemo(() => sortAgentsForBrowse(agents), [agents]);
  const runningCount = useMemo(
    () => agents.filter((a) => a.status === 'running').length,
    [agents],
  );
  const pendingTotal = useMemo(
    () => agents.reduce((n, a) => n + countPendingApprovals(a), 0),
    [agents],
  );

  return (
    <div
      className={`${styles.agentCard} ${styles.agentCardLaunch} ${styles.agentCardDense}`}
      data-agent-side-only="1"
      data-agent-panel="browse"
      role="region"
      aria-label="协作体聊天列表"
    >
      <header className={`${styles.agentCardHeader} ${styles.agentCardHeaderSlim}`}>
        <div className={styles.agentCardTitleRow}>
          <Lucide.Bot size={14} strokeWidth={1.75} aria-hidden />
          <span className={styles.agentCardTitle}>聊天</span>
          {agents.length > 0 ? (
            <span
              className={styles.agentCardBadge}
              title={`共 ${agents.length} 个`}
              aria-label={`共 ${agents.length} 个子智能体`}
            >
              {agents.length}
            </span>
          ) : null}
          {runningCount > 0 ? (
            <span
              className={`${styles.agentCardBadge} ${styles.agentCardBadgeRunning}`}
              role="status"
              aria-label={`${runningCount} 个运行中`}
              title="运行中"
            >
              {runningCount} 运行
            </span>
          ) : null}
          {pendingTotal > 0 ? (
            <span
              className={styles.agentCardBadge}
              role="status"
              aria-label={`${pendingTotal} 项待审批`}
              title="待审批工具"
            >
              {pendingTotal} 待批
            </span>
          ) : null}
        </div>
        {onClose ? (
          <button
            type="button"
            className={styles.agentCardBtn}
            title={embedded ? '返回' : '关闭侧栏'}
            aria-label={embedded ? '返回' : '关闭侧栏'}
            onClick={onClose}
          >
            {embedded ? <Lucide.ChevronLeft size={14} aria-hidden /> : <Lucide.X size={14} aria-hidden />}
          </button>
        ) : null}
      </header>

      <div className={styles.agentLaunchBody}>
        {agents.length === 0 ? (
          <div
            className={styles.skeletonContainer}
            role="status"
            aria-live="polite"
          >
            <div className={styles.skeletonTitleRow}>
              <Lucide.Bot size={13} className={styles.skeletonBotIcon} aria-hidden />
              <span>暂无活跃协作</span>
            </div>
            <div className={styles.skeletonGrid}>
              {[1, 2, 3].map((i) => (
                <div key={i} className={styles.skeletonCard}>
                  <div className={styles.skeletonCardHeader}>
                    <div className={styles.skeletonDot} />
                    <div className={styles.skeletonLineShort} />
                  </div>
                  <div className={styles.skeletonLineLong} />
                  <div className={styles.skeletonLineMedium} />
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className={styles.agentLaunchList} role="list" aria-label="本会话子智能体">
            <div className={styles.agentLaunchListH} id="agent-launch-list-heading">
              本会话 · AI 已拉起
            </div>
            {sorted.map((a) => {
              const name = agentDisplayName(a);
              const pending = countPendingApprovals(a);
              const dur = formatAgentDuration(a);
              const titleBits = [
                name,
                STATUS_LABEL[a.status],
                a.mode ? `模式 ${a.mode}` : '',
                pending ? `${pending} 项待批` : '',
                dur || '',
                (a.summary || '').trim().slice(0, 80),
              ].filter(Boolean);
              return (
                <button
                  key={a.id}
                  type="button"
                  role="listitem"
                  className={styles.agentLaunchItem}
                  data-agent-id={a.id}
                  data-agent-status={a.status}
                  aria-label={`${name}，${STATUS_LABEL[a.status]}${
                    pending ? `，${pending} 项待批` : ''
                  }。在侧栏打开`}
                  title={titleBits.join(' · ')}
                  onClick={() => {
                    // 侧栏 only：禁止主列全屏 / 新会话 ghost
                    openAgentInSidePanel(a.id, {
                      sessionId: parentId || undefined,
                    });
                  }}
                >
                  <Lucide.Bot size={13} strokeWidth={1.75} aria-hidden />
                  <span className={styles.agentLaunchItemT}>{name}</span>
                  {pending > 0 ? (
                    <span
                      className={styles.agentCardBadge}
                      aria-hidden
                      title={`${pending} 项待批`}
                    >
                      待批
                    </span>
                  ) : null}
                  <AgentStatusChip status={a.status} mode={a.mode} compact />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

interface AgentCardProps {
  agentId?: string | null;
  /** 所属主会话；缺省取 activeSessionId */
  parentSessionId?: string | null;
  /**
   * 历史 prop：曾表示主列内嵌全屏。现仅影响关闭钮图标（返回 vs X），
   * 面板始终在侧栏，永不覆盖主对话。
   */
  embedded?: boolean;
  onClose?: () => void;
  /** @deprecated 侧栏 only，忽略；保留类型兼容 */
  onOpenRight?: () => void;
  /** @deprecated 侧栏 only，忽略；保留类型兼容 */
  onOpenWindow?: () => void;
}

export const AgentCard: React.FC<AgentCardProps> = React.memo(({
  agentId,
  parentSessionId,
  embedded,
  onClose,
}) => {
  const sessionsById = useSessionField(selectSessionsById);
  const activeSessionId = useSessionField(selectActiveSessionId);
  const panelAgentId = useSessionField(selectPanelAgentId);
  const patchSessionAgent = useLayoutStore((s) => s.patchSessionAgent);
  const appendSessionAgentMessage = useLayoutStore((s) => s.appendSessionAgentMessage);

  const id = agentId ?? panelAgentId;

  const parentId = parentSessionId || activeSessionId;
  // 优先 O(1) sessionsById；找不到再扫 index 值，不再订阅 sessions 整表
  const sess =
    (parentId ? sessionsById[parentId] : undefined) ||
    (id
      ? Object.values(sessionsById).find((s) => s.agents?.some((a) => a.id === id))
      : undefined);
  const agent =
    (sess && id ? sess.agents?.find((a) => a.id === id) : undefined) ||
    (id
      ? Object.values(sessionsById)
          .flatMap((s) => s.agents || [])
          .find((a) => a.id === id)
      : undefined);

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  /** 切换 agent 时递增，强制 ComposerField 重挂载以 autoFocus + 清空草稿 */
  const [composerEpoch, setComposerEpoch] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const followUpCancelRef = useRef<null | (() => void)>(null);
  const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastAgentIdRef = useRef<string | null | undefined>(undefined);
  /** 焦点代数：切换 agent 后丢弃旧 send finally 的 setSending */
  const focusGenRef = useRef(0);

  const activeWorkspace = useLayoutStore((s) => s.workspaces[s.activeWorkspaceIndex]);
  const onOpenDiff = useCallback((diff: FileDiff) => {
    setActiveDiffSourceAccess(diff);
    if (activeWorkspace) {
      focusOrOpenPanel(activeWorkspace.id, 'diff');
    }
  }, [activeWorkspace]);
  const onOpenPath = useCallback((filePath: string) => {
    if (activeWorkspace) {
      focusOrOpenPanel(activeWorkspace.id, 'files');
    }
    openFileInPanel(filePath);
  }, [activeWorkspace]);
  const onOpenTerminal = useCallback(() => {
    if (activeWorkspace) {
      focusOrOpenPanel(activeWorkspace.id, 'terminal');
    }
  }, [activeWorkspace]);

  /** 侧栏 only：切换/回浏览一律清草稿 + 停本卡 follow-up 流，不串输入 */
  const resetComposerForFocusChange = useCallback(() => {
    focusGenRef.current += 1;
    followUpCancelRef.current?.();
    followUpCancelRef.current = null;
    setInput('');
    setSendError('');
    setSending(false);
    setIsComposing(false);
    setComposerEpoch((n) => n + 1);
  }, []);

  // 侧栏切换子 agent 或回浏览列表：清草稿/错误/流，不串会话输入
  useEffect(() => {
    const prev = lastAgentIdRef.current;
    // 首次挂载仅记录，不清（避免无故丢草稿）
    if (prev === undefined) {
      lastAgentIdRef.current = id ?? null;
      return;
    }
    const next = id ?? null;
    if (prev !== next) {
      resetComposerForFocusChange();
      lastAgentIdRef.current = next;
    }
  }, [id, resetComposerForFocusChange]);

  // 自动滚到底
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [agent?.messages?.length, agent?.status, agent?.summary]);

  // 运行中轮询 daemon 状态（兜底 UI）
  useEffect(() => {
    if (!agent || agent.status !== 'running' || !agent.subagentRunId) return;
    const poll = async () => {
      const st = await getSubagentStatus(agent.subagentRunId);
      if (!st || !sess) return;
      if (st.status && st.status !== 'running' && st.status !== 'unknown') {
        // 仅当仍显示 running 时纠正
        const live = getSessionAgent(sess.id, agent.id);
        if (live?.status === 'running' && /complete|success|failed|cancel|error|stopp?ed|abort/i.test(st.status)) {
          const raw = String(st.status);
          const nextStatus: 'completed' | 'failed' | 'stopped' = /cancel|stopp?ed|abort/i.test(raw)
            ? 'stopped'
            : /fail|error/i.test(raw)
              ? 'failed'
              : 'completed';
          patchSessionAgent(sess.id, agent.id, {
            status: nextStatus,
            endedAt: Date.now(),
            summary:
              live.summary ||
              st.latestError ||
              st.progress ||
              (nextStatus === 'stopped' ? '已停止' : undefined),
          });
        }
      }
    };
    void poll();
    statusPollRef.current = setInterval(() => void poll(), 4000);
    return () => {
      if (statusPollRef.current) clearInterval(statusPollRef.current);
    };
  }, [agent?.id, agent?.status, agent?.subagentRunId, sess?.id, patchSessionAgent]);

  useEffect(() => {
    return () => {
      followUpCancelRef.current?.();
    };
  }, []);

  if (!agent || !sess) {
    return (
      <AgentBrowsePad
        parentSessionId={parentId}
        onClose={onClose}
        embedded={embedded}
      />
    );
  }

  const parentSessId = sess.id;
  const running = agent.status === 'running';
  const canSend = input.trim().length > 0 && !sending;
  const titleName = agentDisplayName(agent);
  const durationLabel = formatAgentDuration(agent);
  const pendingApproval = countPendingApprovals(agent);
  const msgCount = (agent.messages || []).length;

  const applyLocalUserMessage = (text: string) => {
    appendSessionAgentMessage(parentSessId, agent.id, {
      id: `agent-user-${Date.now().toString(36)}`,
      sender: 'user',
      text,
      timestamp: Date.now(),
      status: 'completed',
    });
  };

  /** 运行中：steer；已结束：新 run 续聊（同 agent session 恢复历史） */
  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    const gen = focusGenRef.current;
    const boundAgentId = agent.id;
    setSendError('');
    setSending(true);
    setInput('');

    try {
      // 切换焦点后勿再写旧 agent 的发送态
      if (focusGenRef.current !== gen || lastAgentIdRef.current !== boundAgentId) return;
      if (running && agent.subagentRunId) {
        applyLocalUserMessage(text);
        const res = await sendToSubagent(agent.subagentRunId, text);
        if (focusGenRef.current !== gen || lastAgentIdRef.current !== boundAgentId) return;
        if (!res.ok) {
          setSendError(res.error || '发送失败');
          // 若 run 已结束，降级为 follow-up run
          if (/not|unknown|unsupported|活跃|active/i.test(res.error || '') || res.accepted === false) {
            await startFollowUpRun(text);
          }
        } else if (res.accepted === false) {
          setSendError('当前无法注入消息（可能已结束），改为新一轮续聊…');
          await startFollowUpRun(text);
        }
      } else {
        applyLocalUserMessage(text);
        await startFollowUpRun(text);
      }
    } finally {
      if (focusGenRef.current === gen) setSending(false);
    }
  };

  const startFollowUpRun = (text: string): Promise<void> => {
    return new Promise((resolve) => {
      followUpCancelRef.current?.();
      patchSessionAgent(parentSessId, agent.id, { status: 'running' });

      // 用 subagent 自己的 session 续历史；若无独立 session 则用 agent.id
      const agentSessionId = agent.id;
      let asstId = `agent-asst-${Date.now().toString(36)}`;
      let localRunId: string | null = null;

      appendSessionAgentMessage(parentSessId, agent.id, {
        id: asstId,
        sender: 'assistant',
        text: '',
        thinking: '正在处理…',
        timestamp: Date.now(),
        status: 'processing',
        toolCalls: [],
        blocks: [],
      });

      const patchAsst = (fn: (m: SessionMessage) => void) => {
        useLayoutStore.setState((state) => {
          // 优先 O(1) sessionsById，与主对话/sessionIndex 一致
          const s =
            state.sessionsById[parentSessId] ||
            state.sessions.find((x) => x.id === parentSessId);
          const ag = s?.agents?.find((a) => a.id === agent.id);
          const m = ag?.messages?.find((x) => x.id === asstId);
          if (m) fn(m);
        });
      };

      const cancel = streamCollaboratorRun(text, agentSessionId, {
        onRunMeta: ({ runId }) => {
          localRunId = runId;
          patchSessionAgent(parentSessId, agent.id, {
            subagentRunId: runId,
            status: 'running',
          });
        },
        onThought: (thought) => {
          patchAsst((m) => {
            m.thinking = thought;
          });
        },
        onChunk: (chunk) => {
          patchAsst((m) => {
            m.text = chunk;
            if (m.thinking === '正在处理…') m.thinking = '';
          });
        },
        onToolStart: (toolId, name, args, explanation) => {
          patchAsst((m) => {
            if (!m.toolCalls) m.toolCalls = [];
            if (!m.blocks) m.blocks = [];
            if (!m.toolCalls.some((t) => t.id === toolId)) {
              m.toolCalls.push({
                id: toolId,
                name,
                arguments: args,
                explanation,
                status: 'running',
              });
              m.blocks.push({ type: 'tool_call', id: toolId });
            }
          });
        },
        onToolSuccess: (toolId, output, diffs) => {
          let resolved: import('../store/layoutStore').FileDiff[] = [];
          patchAsst((m) => {
            const tc = m.toolCalls?.find((t) => t.id === toolId);
            if (!tc) return;
            const displayOut = sanitizeToolDisplayOutput(output || '');
            resolved = resolveToolDiffs({
              name: tc.name || '',
              args: tc.arguments,
              output: displayOut,
              structuredDiffs: diffs,
            });
            tc.status = 'success';
            tc.output = displayOut || output || '完成';
            if (resolved.length) tc.diffs = resolved;
          });
          // 必须在 immer set 外推右侧变更，嵌套 set 会被丢弃
          publishToolDiffs(resolved);
        },
        onToolError: (toolId, error) => {
          patchAsst((m) => {
            const tc = m.toolCalls?.find((t) => t.id === toolId);
            if (tc) {
              tc.status = 'error';
              tc.output = sanitizeToolDisplayOutput(error || '') || error || '失败';
            }
          });
        },
        onToolPendingApproval: (toolId, name, args, explanation, approvalMeta) => {
          patchAsst((m) => {
            if (!m.toolCalls) m.toolCalls = [];
            if (!m.blocks) m.blocks = [];
            const existing = m.toolCalls.find((t) => t.id === toolId);
            if (existing) {
              existing.status = 'pending_approval';
              existing.arguments = args || existing.arguments;
              if (explanation) existing.explanation = explanation;
              if (approvalMeta) existing.approvalMeta = approvalMeta;
            } else {
              m.toolCalls.push({
                id: toolId,
                name,
                arguments: args,
                explanation,
                status: 'pending_approval',
                ...(approvalMeta ? { approvalMeta } : {}),
              });
              if (!m.blocks.some((b) => b.type === 'tool_call' && b.id === toolId)) {
                m.blocks.push({ type: 'tool_call', id: toolId });
              }
            }
          });
        },
        onApprovalResolved: (toolId, decision) => {
          patchAsst((m) => {
            const tc = m.toolCalls?.find((t) => t.id === toolId);
            if (!tc) return;
            if (decision === 'allow') {
              tc.status = 'running';
              tc.output = '执行中…';
            } else {
              tc.status = 'error';
              tc.output = '未获批准';
            }
          });
        },
        onSubagentEvent: () => {
          /* 嵌套子 agent 暂不展开 */
        },
        onComplete: () => {
          patchAsst((m) => {
            m.status = 'completed';
            if (m.thinking === '正在处理…') m.thinking = '';
          });
          patchSessionAgent(parentSessId, agent.id, {
            status: 'completed',
            endedAt: Date.now(),
            ...(localRunId ? { subagentRunId: localRunId } : {}),
          });
          followUpCancelRef.current = null;
          resolve();
        },
      });

      followUpCancelRef.current = cancel;
      void getWorkspacePath(); // 确保 cwd 已由主会话设定
    });
  };

  const handleStop = () => {
    followUpCancelRef.current?.();
    followUpCancelRef.current = null;
    if (agent.subagentRunId) {
      void getDesktopCancel(agent.subagentRunId);
    }
    patchSessionAgent(parentSessId, agent.id, {
      status: 'stopped',
      summary: agent.summary || '已停止',
      endedAt: Date.now(),
    });
  };

  const siblingAgents = sess.agents || [];
  const regionLabel = `${titleName} · ${STATUS_LABEL[agent.status]}`;

  return (
    <div
      className={`${styles.agentCard} ${styles.agentCardDense} ${embedded ? styles.agentCardEmbedded : ''}`}
      role="region"
      aria-label={regionLabel}
      aria-busy={running || sending || undefined}
      data-agent-side-only="1"
      data-agent-panel="detail"
      data-agent-id={agent.id}
      data-agent-status={agent.status}
    >
      {/* 侧栏单 agent 详情：无人工委派；多 agent 用 AgentTeamBoard 在侧栏内切换 */}
      <header className={`${styles.agentCardHeader} ${styles.agentCardHeaderSlim}`}>
        <div className={styles.agentCardTitleRow}>
          {/* 返回浏览列表：不关 tab、不碰主列；browse 会触发 id 清空 → 清草稿 */}
          {siblingAgents.length > 0 ? (
            <button
              type="button"
              className={styles.agentCardBtn}
              title="返回子智能体列表"
              aria-label="返回子智能体列表"
              onClick={() => {
                // 先本地清草稿，再 browse（store 异步时仍不串输入）
                resetComposerForFocusChange();
                lastAgentIdRef.current = null;
                browseAgentSidePanel({ sessionId: parentSessId });
              }}
            >
              <Lucide.ChevronLeft size={14} aria-hidden />
            </button>
          ) : null}
          <Lucide.Bot size={14} strokeWidth={1.75} aria-hidden />
          <span
            className={styles.agentCardTitle}
            title={[
              titleName,
              agent.mode ? `模式：${agent.mode}` : '',
              durationLabel || '',
              (agent.summary || '').trim().slice(0, 120),
            ]
              .filter(Boolean)
              .join(' · ')}
          >
            {titleName}
          </span>
          <AgentStatusChip status={agent.status} mode={agent.mode} />
          {pendingApproval > 0 ? (
            <span
              className={styles.agentCardBadge}
              role="status"
              aria-label={`${pendingApproval} 项工具待审批`}
              title="待审批"
            >
              {pendingApproval} 待批
            </span>
          ) : null}
          {durationLabel ? (
            <span
              className={styles.agentCardBadge}
              title={running ? '已运行时长' : '总时长'}
              aria-label={running ? `已运行 ${durationLabel}` : `用时 ${durationLabel}`}
            >
              {durationLabel}
            </span>
          ) : null}
        </div>
        <div className={styles.agentCardActions}>
          {running ? (
            <button
              type="button"
              className={`${styles.agentCardBtn} ${styles.agentCardBtnDanger}`}
              title="停止子智能体"
              aria-label="停止子智能体"
              onClick={handleStop}
            >
              <Lucide.Square size={12} fill="currentColor" aria-hidden />
            </button>
          ) : null}
          {onClose ? (
            <button
              type="button"
              className={styles.agentCardBtn}
              title={embedded ? '返回' : '关闭侧栏'}
              aria-label={embedded ? '返回' : '关闭侧栏'}
              onClick={onClose}
            >
              {embedded ? (
                <Lucide.ChevronLeft size={14} aria-hidden />
              ) : (
                <Lucide.X size={14} aria-hidden />
              )}
            </button>
          ) : null}
        </div>
      </header>

      {siblingAgents.length > 1 ? (
        <AgentTeamBoard
          agents={siblingAgents}
          activeId={agent.id}
          compact
          sessionId={parentSessId}
          onSelect={(nextId) => {
            // 切换即清草稿（TeamBoard 已跳过 active 重选）；再开侧栏 only
            if (nextId === agent.id) return;
            resetComposerForFocusChange();
            lastAgentIdRef.current = nextId;
            openAgentInSidePanel(nextId, { sessionId: parentSessId });
          }}
        />
      ) : null}

      <div
        className={styles.agentCardBody}
        ref={bodyRef}
        role="log"
        aria-label={`${titleName} 的消息`}
        aria-relevant="additions"
        aria-busy={running || undefined}
      >
        {msgCount === 0 ? (
          <div className={styles.agentCardEmptyMsgs} role="status" aria-live="polite">
            {running ? (
              <>
                <span
                  className="loading-spinner"
                  style={{ width: 12, height: 12, borderWidth: 1.5 }}
                  aria-hidden
                />
                <span>正在处理…</span>
              </>
            ) : (
              <span
                style={{
                  display: 'inline-flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Lucide.MessageSquare size={13} strokeWidth={1.75} aria-hidden />
                  暂无消息
                </span>
                <span className={`${styles.agentCardEmptyP} ${styles.agentCardEmptyPMuted}`} style={{ margin: 0 }}>
                  可在下方输入，继续与子智能体对话
                </span>
              </span>
            )}
          </div>
        ) : (
          agent.messages.map((msg, idx) => (
            <AgentMessageRow
              key={msg.id}
              msg={msg}
              parentSessionId={parentSessId}
              agentId={agent.id}
              idx={idx}
              totalMsgs={agent.messages.length}
              onOpenDiff={onOpenDiff}
              onOpenPath={onOpenPath}
              onOpenTerminal={onOpenTerminal}
            />
          ))
        )}
      </div>

      {/* 与主对话同一 ComposerField + footer 渐变；侧栏 denser：maxLines=3 */}
      <div
        className={`chat-footer ${styles.agentCardComposer} ${styles.agentCardComposerDense}`}
        data-agent-composer="dense"
      >
        {sendError ? (
          <div className={styles.agentCardSendError} role="alert" aria-live="assertive">
            {sendError}
          </div>
        ) : null}
        <ComposerField
          key={`agent-composer-${agent.id}-${composerEpoch}`}
          value={input}
          onChange={setInput}
          onSend={() => {
            void handleSend();
          }}
          canSend={canSend}
          disabled={sending}
          isComposing={isComposing}
          setIsComposing={setIsComposing}
          isProcessing={running}
          onStop={handleStop}
          processingSendLabel="发送"
          placeholder={running ? '补充指示…' : '继续对话…'}
          ariaLabel={running ? '向子智能体补充指示' : '继续与子智能体对话'}
          dense
          maxLines={3}
          autoFocus
        />
      </div>
    </div>
  );
});

AgentCard.displayName = 'AgentCard';

async function getDesktopCancel(runId: string): Promise<void> {
  try {
    const { getDesktopDaemonClient } = await import('../api/daemonClient');
    const client = getDesktopDaemonClient();
    await client.send({ type: 'cancel-run', runId });
  } catch {
    /* ignore */
  }
}

function AgentMessageRow({
  msg,
  parentSessionId,
  agentId,
  idx,
  totalMsgs,
  onOpenDiff,
  onOpenPath,
  onOpenTerminal,
}: {
  msg: SessionMessage;
  parentSessionId: string;
  agentId: string;
  idx: number;
  totalMsgs: number;
  onOpenDiff: (diff: FileDiff) => void;
  onOpenPath: (filePath: string) => void;
  onOpenTerminal: () => void;
}) {
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const onToggleTool = useCallback((toolId: string, currentlyOpen: boolean) => {
    setExpandedTools((prev) => ({ ...prev, [toolId]: !currentlyOpen }));
  }, []);
  // ApprovalAskCard 二次确认后落地：busy + remember 白名单
  const { approvalBusy, onApprovalAllow, onApprovalDeny } = useAgentToolApproval(
    parentSessionId,
    agentId,
  );

  if (msg.sender === 'user') {
    return (
      <ChatUserMessageRow
        msg={msg}
        isPinned={false}
        isSearchHit={false}
        isExpanded={true}
        onToggleExpand={() => {}}
        onTogglePin={() => {}}
        onWithdraw={() => {}}
      />
    );
  }

  const isLastAssistant = idx === totalMsgs - 1;
  const isThinkingMsg = msg.status === 'processing' || msg.status === 'queued';

  return (
    <ChatAssistantMessageRow
      msg={msg}
      isFollowUp={false}
      isPinned={false}
      isSearchHit={false}
      isThinkingMsg={isThinkingMsg}
      thinkingSeconds={0}
      hideThinkingBlock={false}
      inPlanMode={false}
      planApproved={false}
      isLastAssistant={isLastAssistant}
      toolStackProps={{
        agents: [],
        activeSessionId: parentSessionId,
        expandedTools: expandedTools,
        onToggleTool: onToggleTool,
        approvalBusy: approvalBusy,
        pendingApprovalMsgId: msg.id,
        onOpenDiff: onOpenDiff,
        onOpenPath: onOpenPath,
        onOpenTerminal: onOpenTerminal,
        onApprovalAllow: onApprovalAllow,
        onApprovalDeny: onApprovalDeny,
      }}
      onTogglePin={() => {}}
      onShowToast={() => {}}
      onRegenerate={() => {}}
      onBranch={() => {}}
      onOpenDiff={onOpenDiff}
      onOpenDiffPanel={() => {}}
      setPermissionMode={() => {}}
      setPlanApproved={() => {}}
    />
  );
}

/** 新窗口打开 agent 只读快照（Blob URL，避免 document.write）；非侧栏主路径 */
export function openAgentInNewWindow(agent: SessionAgent): void {
  const w = window.open('', '_blank', 'noopener,noreferrer,width=720,height=900');
  if (!w) return;
  const esc = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const statusLabel = STATUS_LABEL[agent.status] || '完成';
  const lines: string[] = [];
  lines.push(`<h1>${esc(agent.description || '协作智能体')}</h1>`);
  lines.push(
    `<p class="meta">${esc(agent.mode || '')} · ${esc(statusLabel)}${
      agent.summary ? ' · ' + esc(agent.summary) : ''
    }</p>`,
  );
  for (const m of agent.messages || []) {
    if (m.sender === 'user') {
      lines.push(`<div class="u">${esc(m.text || '')}</div>`);
    } else {
      lines.push(`<div class="a">${esc(m.text || '')}</div>`);
      for (const tc of m.toolCalls || []) {
        const tcStatus =
          tc.status === 'success'
            ? '成功'
            : tc.status === 'error'
              ? '失败'
              : tc.status === 'running'
                ? '执行中'
                : tc.status === 'pending_approval'
                  ? '待审批'
                  : String(tc.status || '');
        lines.push(
          `<div class="t"><b>${esc(tc.name)}</b> ${esc(tcStatus)}<pre>${esc(
            (tc.output || '').slice(0, 2000),
          )}</pre></div>`,
        );
      }
    }
  }
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><title>${esc(
    agent.description || '子智能体',
  )}</title>
<style>
body{font-family:system-ui,sans-serif;padding:20px;max-width:720px;margin:0 auto;color:#222;background:#fafafa}
h1{font-size:18px;margin:0 0 8px}.meta{color:#888;font-size:12px;margin:0 0 20px}
.u{background:#e8eef8;padding:10px 12px;border-radius:12px;margin:10px 0 10px auto;max-width:85%;width:fit-content}
.a{background:#fff;border:1px solid #eee;padding:10px 12px;border-radius:12px;margin:10px 0;white-space:pre-wrap}
.t{font-size:12px;color:#666;margin:6px 0 6px 8px}pre{white-space:pre-wrap;font-size:11px;background:#f4f4f5;padding:8px;border-radius:6px}
</style></head><body>${lines.join('\n')}</body></html>`;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const revoke = () => {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  };
  try {
    w.addEventListener('load', revoke, { once: true });
  } catch {
    /* ignore */
  }
  // 兜底：部分环境 load 不可靠
  window.setTimeout(revoke, 60_000);
  w.location.href = url;
}
