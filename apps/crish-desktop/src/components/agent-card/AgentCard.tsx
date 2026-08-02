/**
 * 协作体「聊天」侧栏：时间线 + 可交互输入（运行中 steer / 结束后新 run 续聊）。
 * 标签名「聊天」；列表/入口在总览或主对话，勿从 + 菜单随意添加。
 * 契约：仅侧栏展示；打开/切换一律 openAgentInSidePanel / browseAgentSidePanel，
 * 永不覆盖主对话、不 spawn 主会话 ghost。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import styles from './AgentCard.module.css';
import { Tooltip } from '../Tooltip';
import * as Lucide from 'lucide-react';
import { browseAgentSidePanel, openAgentInSidePanel } from '../../api/openAgentPanel';
import { useLayoutStore } from '../../api/store-access/componentAccess';
import type { FileDiff } from '../../store/layoutStore';
import { focusOrOpenPanel, setActiveDiffSource as setActiveDiffSourceAccess } from '../../api/storeAccess';
import { openFileInPanel } from '../../api/workspaceFsApi';
import {
  getSessionAgent,
  selectActiveSessionId,
  selectPanelAgentId,
  selectSessionsById,
  useSessionField,
} from '../../api/store-access/componentAccess';
import {
  getSubagentStatus,
} from '../../api/subagentApi';
import { ComposerField } from '../chat-composer/ChatComposer';
import { AgentTeamBoard } from './AgentTeamBoard';
import { useAgentPanel } from '../../hooks/useAgentStream';
import { AgentStatusChip } from './AgentStatusChip';
import { AgentBrowsePad } from './AgentBrowsePad';
import { AgentMessageRow } from './AgentMessageRow';
import {
  STATUS_LABEL,
  agentDisplayName,
  countPendingApprovals,
  formatAgentDuration,
  openAgentInNewWindow,
} from './agentCardUtils';

export { openAgentInNewWindow };

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
  const {
    handleSend: hookHandleSend,
    handleStop: hookHandleStop,
    handleForceStop: hookHandleForceStop,
    sending,
    sendError,
    setSendError,
    incrementEpoch,
  } = useAgentPanel({
    parentSessionId: parentId || '',
    agentId: id || '',
    isRunning: agent?.status === 'running',
  });

  const [input, setInput] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  /** 切换 agent 时递增，强制 ComposerField 重挂载以 autoFocus + 清空草稿 */
  const [composerEpoch, setComposerEpoch] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    incrementEpoch();
    setInput('');
    setSendError('');
    setIsComposing(false);
    setComposerEpoch((n) => n + 1);
  }, [incrementEpoch, setSendError]);

  // 侧栏切换子 agent 或回浏览列表：清草稿/错误/流，不串会话输入
  const prevIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const prev = prevIdRef.current;
    if (prev === undefined) {
      prevIdRef.current = id ?? null;
      return;
    }
    const next = id ?? null;
    if (prev !== next) {
      resetComposerForFocusChange();
      prevIdRef.current = next;
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
          const agentSummary = live.summary || st.latestError || st.progress || (nextStatus === 'stopped' ? '已停止' : undefined);
          patchSessionAgent(sess.id, agent.id, {
            status: nextStatus,
            endedAt: Date.now(),
            ...(agentSummary !== undefined ? { summary: agentSummary } : {}),
          });
        }
      }
    };
    void poll();
    statusPollRef.current = setInterval(() => void poll(), 4000);
    return () => {
      if (statusPollRef.current) clearInterval(statusPollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 轮询只依赖已列出的字段，纳入整个对象会因无关变更重启轮询
  }, [agent?.id, agent?.status, agent?.subagentRunId, sess?.id, patchSessionAgent]);

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
            <Tooltip content="返回子智能体列表">
              <button
                type="button"
                className={styles.agentCardBtn}
                aria-label="返回子智能体列表"
                onClick={() => {
                  // 先本地清草稿，再 browse（store 异步时仍不串输入）
                  resetComposerForFocusChange();
                  browseAgentSidePanel({ sessionId: parentSessId });
                }}
              >
                <Lucide.ChevronLeft size={14} aria-hidden />
              </button>
            </Tooltip>
          ) : null}
          <Lucide.Bot size={14} strokeWidth={1.75} aria-hidden />
          <Tooltip
            content={[
              titleName,
              agent.mode ? `模式：${agent.mode}` : '',
              durationLabel || '',
              (agent.summary || '').trim().slice(0, 120),
            ]
              .filter(Boolean)
              .join(' · ')}
          >
            <span className={styles.agentCardTitle}>
              {titleName}
            </span>
          </Tooltip>
          <AgentStatusChip status={agent.status} mode={agent.mode} />
          {pendingApproval > 0 ? (
            <Tooltip content="待审批">
              <span
                className={styles.agentCardBadge}
                role="status"
                aria-label={`${pendingApproval} 项工具待审批`}
              >
                {pendingApproval} 待批
              </span>
            </Tooltip>
          ) : null}
          {durationLabel ? (
            <Tooltip content={running ? '已运行时长' : '总时长'}>
              <span
                className={styles.agentCardBadge}
                aria-label={running ? `已运行 ${durationLabel}` : `用时 ${durationLabel}`}
              >
                {durationLabel}
              </span>
            </Tooltip>
          ) : null}
        </div>
        <div className={styles.agentCardActions}>
          {running ? (
            <Tooltip content="停止子智能体">
              <button
                type="button"
                className={`${styles.agentCardBtn} ${styles.agentCardBtnDanger}`}
                aria-label="停止子智能体"
                onClick={() => hookHandleStop(agent.summary)}
              >
                <Lucide.Square size={12} fill="currentColor" aria-hidden />
              </button>
            </Tooltip>
          ) : null}
          {onClose ? (
            <Tooltip content={embedded ? '返回' : '关闭侧栏'}>
              <button
                type="button"
                className={styles.agentCardBtn}
                aria-label={embedded ? '返回' : '关闭侧栏'}
                onClick={onClose}
              >
                {embedded ? (
                  <Lucide.ChevronLeft size={14} aria-hidden />
                ) : (
                  <Lucide.X size={14} aria-hidden />
                )}
              </button>
            </Tooltip>
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
            const text = input.trim();
            if (text) {
              setInput('');
              void hookHandleSend(text);
            }
          }}
          canSend={canSend}
          disabled={sending}
          isComposing={isComposing}
          setIsComposing={setIsComposing}
          isProcessing={running}
          onStop={() => hookHandleStop(agent.summary)}
          onForceStop={() => hookHandleForceStop(agent.summary)}
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
