/**
 * 主对话时间线内的协作 agent 块（像工具行一样嵌在流里，可展开）。
 *
 * 契约（再扫）：
 * - 打开详情只走 openAgentInSidePanel（侧栏 only，永不 setActiveAgentId / 新窗口）
 * - 开面板前用 planOpenAgentInSidePanel 纯规划（空 id reject；reuse 感知）
 * - 输入区 ComposerField dense + maxLines=3，壳与侧栏 AgentCard 同轨
 * - 运行中可停止：折叠头 / 工具条 / Composer 停止钮共用 handleStop
 * - 卸载安全：取消 follow-up 流，迟到 setState 不写回
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import type { SessionAgent } from '../store/layoutStore';
import { useLayoutStore } from '../store/layoutStore';
import styles from './InlineAgentPanel.module.css';
import {
  selectActiveAgentId,
  selectPanelAgentId,
  useSessionField,
} from '../store/sessionStore';
import { buildAssistantTimeline } from '../api/toolPresentation';
import { parseMarkdownToHtml, stripThoughtPlaceholders } from '../api/markdownRender';
import { resolveToolDiffs, sanitizeToolDisplayOutput } from '../api/toolFeedback';
import { publishToolDiffs } from '../api/publishToolDiffs';
import {
  sendToSubagent,
  streamCollaboratorRun,
} from '../api/subagentApi';
import {
  normalizeAgentPanelAgentId,
  openAgentInSidePanel,
  planOpenAgentInSidePanel,
  resolveAgentPanelLabel,
  resolveAgentPanelStatusLabel,
  resolveAgentPanelTitle,
  shouldReuseAgentPanelFocus,
} from '../api/openAgentPanel';
import { ComposerField } from './ChatComposer';
import { ChatToolStack } from './ChatToolCallBlock';
import { useAgentToolApproval } from '../hooks/useAgentToolApproval';
import { Tooltip } from './settings/SettingsUI';

/** 内联 denser：比主列 / 侧栏默认 4 行再收一行，避免时间线被撑爆 */
const INLINE_COMPOSER_MAX_LINES = 3;

interface InlineAgentPanelProps {
  agent: SessionAgent;
  parentSessionId: string;
  /** 默认折叠，运行中可默认展开 */
  defaultOpen?: boolean;
}

export const InlineAgentPanel: React.FC<InlineAgentPanelProps> = ({
  agent,
  parentSessionId,
  defaultOpen,
}) => {
  const [open, setOpen] = useState(Boolean(defaultOpen ?? agent.status === 'running'));
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  /** 与主对话一致：工具默认折叠 */
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const bodyRef = useRef<HTMLDivElement>(null);
  const followUpCancelRef = useRef<null | (() => void)>(null);
  /** 用户已点停止：忽略后续 onComplete 写回 completed */
  const userStoppedRef = useRef(false);
  /** follow-up 代数：停止后迟到的回调不再 patch */
  const followUpEpochRef = useRef(0);
  /** 组件仍挂载：send/stop 异步 finally 勿 setState */
  const mountedRef = useRef(true);
  /** 停止防抖 timer：卸载时清掉，避免 residual setStopping */
  const stopCooldownTimerRef = useRef<number | null>(null);

  const reactId = useId();
  const bodyDomId = `inline-agent-body-${reactId}`;
  const labelDomId = `inline-agent-label-${reactId}`;

  const patchSessionAgent = useLayoutStore((s) => s.patchSessionAgent);
  const appendSessionAgentMessage = useLayoutStore((s) => s.appendSessionAgentMessage);
  const onToggleTool = useCallback((toolId: string, currentlyOpen: boolean) => {
    setExpandedTools((prev) => ({ ...prev, [toolId]: !currentlyOpen }));
  }, []);

  /** 侧栏焦点订阅：reuse / 「已在侧栏」徽标 */
  const panelAgentId = useSessionField(selectPanelAgentId);
  const activeAgentId = useSessionField(selectActiveAgentId);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      followUpCancelRef.current?.();
      followUpCancelRef.current = null;
      if (stopCooldownTimerRef.current != null) {
        window.clearTimeout(stopCooldownTimerRef.current);
        stopCooldownTimerRef.current = null;
      }
    };
  }, []);

  // 实时 agent 数据（O(1) sessionsById）
  const live =
    useSessionField(
      (s) => s.sessionsById[parentSessionId]?.agents?.find((a) => a.id === agent.id),
    ) || agent;

  const agentIdNorm = normalizeAgentPanelAgentId(live.id) ?? '';
  const running = live.status === 'running';

  /** 标题 / 短标签 / 状态：与 openAgentPanel 纯函数同轨（中文） */
  const displayTitle = useMemo(
    () => resolveAgentPanelTitle(live),
    [live.description, live.mode, live.id],
  );
  const displayLabel = useMemo(
    () => resolveAgentPanelLabel(live),
    [live.description, live.mode, live.id],
  );
  const statusLabel = resolveAgentPanelStatusLabel(live.status);

  /**
   * 侧栏已聚焦本 agent 且主列干净 → reuse 态（无需换 id）。
   * activeAgentId 脏时强制非 reuse，开侧栏会清主列。
   */
  const sideFocused = shouldReuseAgentPanelFocus(
    panelAgentId,
    agentIdNorm,
    activeAgentId,
  );

  // 审批：与主对话同路径（ApprovalAskCard 二次确认 + remember）
  const { approvalBusy, onApprovalAllow, onApprovalDeny } = useAgentToolApproval(
    parentSessionId,
    live.id,
  );

  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);

  useEffect(() => {
    if (!open || !bodyRef.current) return;
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [open, live.messages?.length, live.status]);

  /**
   * 侧栏 only 出口：
   * 1) 空 id → no-op（plan reject empty-agent-id）
   * 2) 纯规划校验 side-only 不变量
   * 3) 命令式 openAgentInSidePanel（内部仍 plan + 清主列；reuse 时 re-emit 保 tab）
   * 永不 setActiveAgentId / 新窗口
   */
  const openInSideOnly = useCallback(
    (e?: React.MouseEvent) => {
      e?.stopPropagation();
      e?.preventDefault();
      const id = normalizeAgentPanelAgentId(live.id);
      if (!id) return;

      const plan = planOpenAgentInSidePanel({
        mode: 'focus',
        agentId: id,
        sessionId: parentSessionId,
        panelAgentId,
        activeAgentId,
        agent: live,
      });
      // empty-agent-id / missing-agent：静默拒绝，主列无副作用
      if (plan.action === 'reject') return;
      if (plan.action !== 'focus' || plan.setActiveAgentId !== false) return;

      openAgentInSidePanel(id, { sessionId: parentSessionId });
    },
    [live, parentSessionId, panelAgentId, activeAgentId],
  );

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending || stopping || !agentIdNorm) return;
    setSending(true);
    setInput('');
    appendSessionAgentMessage(parentSessionId, live.id, {
      id: `iu-${Date.now().toString(36)}`,
      sender: 'user',
      text,
      timestamp: Date.now(),
      status: 'completed',
    });
    try {
      if (running && live.subagentRunId) {
        const res = await sendToSubagent(live.subagentRunId, text);
        if (!res.ok || res.accepted === false) {
          // 降级新一轮
          startFollowUp(text);
        }
      } else {
        startFollowUp(text);
      }
    } finally {
      if (mountedRef.current) setSending(false);
    }
  };

  const startFollowUp = (text: string) => {
    followUpCancelRef.current?.();
    userStoppedRef.current = false;
    const epoch = ++followUpEpochRef.current;
    patchSessionAgent(parentSessionId, live.id, { status: 'running' });
    const asstId = `ia-${Date.now().toString(36)}`;
    appendSessionAgentMessage(parentSessionId, live.id, {
      id: asstId,
      sender: 'assistant',
      text: '',
      thinking: '正在处理…',
      timestamp: Date.now(),
      status: 'processing',
      toolCalls: [],
      blocks: [],
    });
    const patchAsst = (fn: (m: import('../store/layoutStore').SessionMessage) => void) => {
      if (userStoppedRef.current || followUpEpochRef.current !== epoch) return;
      useLayoutStore.setState((state) => {
        // 优先 O(1) sessionsById（与侧栏 AgentCard 一致）
        const sess =
          state.sessionsById[parentSessionId] ||
          state.sessions.find((s) => s.id === parentSessionId);
        const ag = sess?.agents?.find((a) => a.id === live.id);
        const m = ag?.messages?.find((x) => x.id === asstId);
        if (m) fn(m);
      });
    };
    const cancel = streamCollaboratorRun(text, live.id, {
      onRunMeta: ({ runId }) => {
        if (userStoppedRef.current || followUpEpochRef.current !== epoch) return;
        patchSessionAgent(parentSessionId, live.id, { subagentRunId: runId, status: 'running' });
      },
      onThought: (t) => patchAsst((m) => { m.thinking = t; }),
      onChunk: (c) => patchAsst((m) => { m.text = c; if (m.thinking === '正在处理…') m.thinking = ''; }),
      onToolStart: (toolId, name, args, explanation) => {
        patchAsst((m) => {
          if (!m.toolCalls) m.toolCalls = [];
          if (!m.blocks) m.blocks = [];
          if (!m.toolCalls.some((t) => t.id === toolId)) {
            m.toolCalls.push({ id: toolId, name, arguments: args, explanation, status: 'running' });
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
        if (!userStoppedRef.current && followUpEpochRef.current === epoch) {
          publishToolDiffs(resolved);
        }
      },
      onToolError: (toolId, err) => {
        patchAsst((m) => {
          const tc = m.toolCalls?.find((t) => t.id === toolId);
          if (tc) {
            tc.status = 'error';
            tc.output = sanitizeToolDisplayOutput(err || '') || err || '失败';
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
            m.blocks.push({ type: 'tool_call', id: toolId });
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
      onComplete: () => {
        if (userStoppedRef.current || followUpEpochRef.current !== epoch) {
          followUpCancelRef.current = null;
          return;
        }
        patchAsst((m) => {
          m.status = 'completed';
          if (m.thinking === '正在处理…') m.thinking = '';
        });
        patchSessionAgent(parentSessionId, live.id, { status: 'completed', endedAt: Date.now() });
        followUpCancelRef.current = null;
      },
    });
    followUpCancelRef.current = cancel;
  };

  /** 收尾进行中的 assistant 消息与工具行（status 仅 processing→completed） */
  const finalizeInFlightOnStop = useCallback(() => {
    useLayoutStore.setState((state) => {
      const sess =
        state.sessionsById[parentSessionId] ||
        state.sessions.find((s) => s.id === parentSessionId);
      const ag = sess?.agents?.find((a) => a.id === live.id);
      if (!ag?.messages) return;
      for (const m of ag.messages) {
        if (m.sender !== 'assistant') continue;
        if (m.status === 'processing') {
          m.status = 'completed';
          if (m.thinking === '正在处理…') m.thinking = '';
        }
        for (const tc of m.toolCalls || []) {
          if (tc.status === 'running' || tc.status === 'pending_approval') {
            tc.status = 'error';
            tc.output = tc.output && tc.output !== '执行中…' ? tc.output : '已停止';
          }
        }
      }
    });
  }, [live.id, parentSessionId]);

  const handleStop = useCallback(
    (e?: React.MouseEvent) => {
      e?.stopPropagation();
      e?.preventDefault();
      if (stopping) return;
      setStopping(true);
      userStoppedRef.current = true;
      followUpEpochRef.current += 1;
      followUpCancelRef.current?.();
      followUpCancelRef.current = null;

      const runId = live.subagentRunId;
      if (runId) {
        void cancelSubagentRun(runId);
      }

      finalizeInFlightOnStop();
      patchSessionAgent(parentSessionId, live.id, {
        status: 'stopped',
        summary: live.summary || '已停止',
        endedAt: Date.now(),
      });
      // 短延迟后允许再次交互（避免连点）；卸载时清 timer
      if (stopCooldownTimerRef.current != null) {
        window.clearTimeout(stopCooldownTimerRef.current);
      }
      stopCooldownTimerRef.current = window.setTimeout(() => {
        stopCooldownTimerRef.current = null;
        if (mountedRef.current) setStopping(false);
      }, 200);
    },
    [
      stopping,
      live.subagentRunId,
      live.summary,
      live.id,
      parentSessionId,
      finalizeInFlightOnStop,
      patchSessionAgent,
    ],
  );

  const messages = live.messages || [];
  const msgCount = messages.length;
  const pendingTools = messages.reduce((n, m) => {
    return n + (m.toolCalls || []).filter((t) => t.status === 'pending_approval').length;
  }, 0);

  const canSend = Boolean(input.trim()) && !sending && !stopping && Boolean(agentIdNorm);

  /** 空消息列表：按状态中文文案 */
  const emptyStreamCopy = useMemo(() => {
    if (running) return '子智能体执行中，产出将显示在此…';
    if (live.status === 'failed') return '暂无消息（运行失败）。可在下方重试，或在侧栏查看详情。';
    if (live.status === 'stopped') return '暂无消息（已停止）。可继续发送以开启新一轮。';
    if (live.summary?.trim()) {
      return `暂无消息记录。摘要：${live.summary.trim().slice(0, 80)}`;
    }
    return '暂无消息。可在下方继续对话，或在侧栏打开完整视图。';
  }, [running, live.status, live.summary]);

  const sideOpenTitle = sideFocused
    ? '已在侧栏打开（点击重聚焦，不覆盖主对话）'
    : '在侧栏打开（不覆盖主对话）';
  const sideOpenAria = sideFocused
    ? `已在侧栏打开「${displayTitle}」，点击重聚焦`
    : `在侧栏打开子智能体「${displayTitle}」`;
  const regionAria = `${displayTitle}，${statusLabel}${sideFocused ? '，已在侧栏' : ''}`;

  return (
    <div
      className={`${styles.inlineAgent} ${styles.inlineAgentDense} ${open ? styles.isOpen : ''} ${
        live.status === 'running'
          ? styles.inlineAgentRunning
          : live.status === 'failed'
            ? styles.inlineAgentFailed
            : live.status === 'stopped'
              ? styles.inlineAgentStopped
              : ''
      }${sideFocused ? ` ${styles.sideFocused}` : ''}`}
      role="region"
      aria-label={regionAria}
      aria-labelledby={labelDomId}
      aria-busy={running || undefined}
      data-agent-id={live.id}
      data-agent-open-target="side-panel-only"
      data-side-focused={sideFocused ? '1' : '0'}
      data-composer-dense="1"
    >
      <div className={styles.inlineAgentHeadRow}>
        <button
          type="button"
          className={styles.inlineAgentHead}
          aria-expanded={open}
          aria-controls={bodyDomId}
          id={labelDomId}
          onClick={() => setOpen((v) => !v)}
        >
          {running ? (
            <span className="tool-row-live" aria-hidden>
              <span className="loading-spinner" style={{ width: 8, height: 8, borderWidth: 1.5 }} />
            </span>
          ) : (
            <Lucide.Bot size={13} className="inline-agent-ico" aria-hidden />
          )}
          <span className={styles.inlineAgentLabel}>
            {displayLabel}
          </span>
          <span
            className={`${styles.inlineAgentBadge} ${
              live.status === 'running'
                ? styles.inlineAgentBadgeRunning
                : live.status === 'failed'
                  ? styles.inlineAgentBadgeFailed
                  : live.status === 'stopped'
                    ? styles.inlineAgentBadgeStopped
                    : ''
            }`}
            aria-live="polite"
          >
            {statusLabel}
          </span>
          {sideFocused ? (
            <Tooltip content="已在侧栏聚焦">
              <span
                className={`${styles.inlineAgentBadge} ${styles.inlineAgentBadgeSide}`}
                aria-label="已在侧栏聚焦"
              >
                侧栏
              </span>
            </Tooltip>
          ) : null}
          {pendingTools > 0 ? (
            <Tooltip content={`待审批 ${pendingTools} 项`}>
              <span
                className={`${styles.inlineAgentBadge} ${styles.inlineAgentBadgePending}`}
                aria-label={`待审批 ${pendingTools} 项`}
              >
                待批 {pendingTools}
              </span>
            </Tooltip>
          ) : null}
          {live.mode ? (
            <Tooltip content={live.mode}>
              <span className={styles.inlineAgentMode}>
                {live.mode}
              </span>
            </Tooltip>
          ) : null}
          <span className={styles.inlineAgentMeta}>
            {msgCount} 条
            {live.summary ? ` · ${live.summary.slice(0, 36)}` : ''}
          </span>
          <Lucide.ChevronRight
            size={13}
            className={`tool-row-chevron ${open ? 'rot' : ''}`}
            aria-hidden
          />
        </button>
        {/* 折叠态也可：停止 / 侧栏 only（不依赖展开 Composer） */}
        <div className={styles.inlineAgentHeadActions}>
          {running ? (
            <Tooltip content={stopping ? '停止中…' : '停止子智能体'}>
              <button
                type="button"
                className={`agent-card-btn agent-card-btn--danger ${styles.inlineAgentStopBtn}`}
                aria-label={stopping ? '正在停止子智能体' : '停止子智能体'}
                aria-busy={stopping || undefined}
                disabled={stopping}
                onClick={handleStop}
              >
                <Lucide.Square size={11} fill="currentColor" aria-hidden />
              </button>
            </Tooltip>
          ) : null}
          <Tooltip content={sideOpenTitle}>
            <button
              type="button"
              className={`agent-card-btn ${styles.inlineAgentHeadActions} ${sideFocused ? 'is-active' : ''}`}
              aria-label={sideOpenAria}
              aria-pressed={sideFocused}
              disabled={!agentIdNorm}
              onClick={openInSideOnly}
            >
              <Lucide.PanelRight size={13} aria-hidden />
            </button>
          </Tooltip>
        </div>
      </div>

      {open ? (
        <div className={styles.inlineAgentBody} id={bodyDomId} role="group" aria-label={`${displayTitle} 详情`}>
          <div className={styles.inlineAgentToolbar}>
            <Tooltip content={sideOpenTitle}>
              <button
                type="button"
                className={styles.inlineAgentLink}
                data-open-target="side-panel"
                data-side-reused={sideFocused ? '1' : '0'}
                aria-label={sideOpenAria}
                disabled={!agentIdNorm}
                onClick={openInSideOnly}
              >
                {sideFocused ? '已在侧栏 · 重聚焦' : '在侧栏打开'}
              </button>
            </Tooltip>
            {running ? (
              <Tooltip content="停止生成">
                <button
                  type="button"
                  className={`${styles.inlineAgentLink} ${styles.inlineAgentLinkStop}`}
                  aria-label="停止生成"
                  aria-busy={stopping || undefined}
                  disabled={stopping}
                  onClick={handleStop}
                >
                  {stopping ? '停止中…' : '停止'}
                </button>
              </Tooltip>
            ) : null}
            {pendingTools > 0 ? (
              <span className={styles.inlineAgentToolbarHint} role="status">
                有 {pendingTools} 项待确认
              </span>
            ) : null}
          </div>

          <div
            className={styles.inlineAgentStream}
            ref={bodyRef}
            role="log"
            aria-relevant="additions"
            aria-busy={running || undefined}
          >
            {msgCount === 0 ? (
              <div className={styles.inlineAgentEmpty} role="status">
                <p className={styles.inlineAgentEmptyP} style={{ margin: 0 }}>
                  {emptyStreamCopy}
                </p>
                {agentIdNorm ? (
                  <Tooltip content={sideOpenTitle}>
                    <button
                      type="button"
                      className={styles.inlineAgentLink}
                      data-open-target="side-panel"
                      style={{ marginTop: 6 }}
                      aria-label={sideOpenAria}
                      onClick={openInSideOnly}
                    >
                      {sideFocused ? '已在侧栏 · 重聚焦' : '在侧栏打开完整视图'}
                    </button>
                  </Tooltip>
                ) : null}
              </div>
            ) : (
              messages.map((msg) => (
                <div key={msg.id} className={`${styles.inlineAgentMsg} inline-agent-msg--${msg.sender}`}>
                  {msg.sender === 'user' ? (
                    <div className="agent-prompt-bubble">{msg.text}</div>
                  ) : (
                    <>
                      {msg.thinking &&
                      msg.thinking.trim() &&
                      msg.thinking !== '正在处理…' &&
                      !looksLikeShellDump(msg.thinking) ? (
                        <details className="msg-thinking-fold">
                          <summary className="msg-thinking-fold-sum">
                            <span className="msg-thinking-fold-label">思考</span>
                          </summary>
                          <div className="msg-thinking-fold-body">{msg.thinking.slice(0, 3000)}</div>
                        </details>
                      ) : null}
                      {(() => {
                        const timeline = buildAssistantTimeline(msg);
                        if (!timeline.length && (msg.text || '').trim()) {
                          return (
                            <div
                              className="msg-assistant-text md-rendered"
                              dangerouslySetInnerHTML={{
                                __html: parseMarkdownToHtml(
                                  stripThoughtPlaceholders(msg.text || ''),
                                ),
                              }}
                            />
                          );
                        }
                        return timeline.map((item) => {
                          if (item.kind === 'text') {
                            const body = stripThoughtPlaceholders(item.content || '');
                            if (!body.trim()) return null;
                            return (
                              <div
                                key={item.key}
                                className="msg-timeline-text msg-assistant-text md-rendered"
                                dangerouslySetInnerHTML={{
                                  __html: parseMarkdownToHtml(body),
                                }}
                              />
                            );
                          }
                          return (
                            <div key={item.key} className="msg-timeline-tools agent-tool-stack">
                              <ChatToolStack
                                items={item.items}
                                msgId={msg.id}
                                agents={[]}
                                activeSessionId={parentSessionId}
                                expandedTools={expandedTools}
                                onToggleTool={onToggleTool}
                                approvalBusy={approvalBusy}
                                pendingApprovalMsgId={msg.id}
                                onOpenDiff={() => {}}
                                onOpenPath={() => {}}
                                onOpenTerminal={() => {}}
                                onApprovalAllow={onApprovalAllow}
                                onApprovalDeny={onApprovalDeny}
                              />
                            </div>
                          );
                        });
                      })()}
                    </>
                  )}
                </div>
              ))
            )}
          </div>

          {/* denser ComposerField：footer 渐变 + ≤3 行增高 + 主题半透壳 */}
          <div
            className={`chat-footer agent-card-composer agent-card-composer--dense ${styles.inlineAgentComposerWrap} ${styles.inlineAgentComposerWrapDense}`}
            data-composer="inline-agent-dense"
          >
            <ComposerField
              value={input}
              onChange={setInput}
              onSend={() => {
                void handleSend();
              }}
              canSend={canSend}
              disabled={sending || stopping || !agentIdNorm}
              isComposing={isComposing}
              setIsComposing={setIsComposing}
              isProcessing={running}
              onStop={handleStop}
              processingSendLabel="发送"
              maxLines={INLINE_COMPOSER_MAX_LINES}
              placeholder={
                !agentIdNorm
                  ? '子智能体不可用…'
                  : running
                    ? '向子智能体补充指示…'
                    : '继续向该子智能体发消息…'
              }
              ariaLabel={
                !agentIdNorm
                  ? '子智能体不可用'
                  : running
                    ? '向内联子智能体补充指示'
                    : '继续与内联子智能体对话'
              }
              dense
            />
          </div>
        </div>
      ) : null}
    </div>
  );
};

/** 向 daemon 发 cancel-run；失败静默（UI 已本地标 stopped） */
async function cancelSubagentRun(runId: string): Promise<void> {
  try {
    const { getDesktopDaemonClient } = await import('../api/daemonClient');
    await getDesktopDaemonClient().send({ type: 'cancel-run', runId });
  } catch {
    /* ignore */
  }
}

/** 避免把 shell 表格拉进「思考」折叠 */
function looksLikeShellDump(s: string): boolean {
  return (
    /FullName|LastWriteTime|Mode\s+Length|----/.test(s) ||
    (/^[A-Za-z]:\\/.test(s.trim()) && s.includes('\n') && s.split('\n').length > 4)
  );
}
