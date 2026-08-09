/**
 * 主对话时间线内的协作 agent 块（像工具行一样嵌在流里，可展开）。
 *
 * 契约（再扫）：
 * - 打开详情只走 openAgentInSidePanel（侧栏 only，永不 setActiveAgentId / 新窗口）
 * - 开面板前用 planOpenAgentInSidePanel 纯规划（空 id reject；reuse 感知）
 * - 输入区 ComposerField dense + maxLines=3，壳与侧栏 AgentCard 同轨
 * - 运行中可停止：折叠头 / 工具条 / Composer 默认 Stop=L2；Composer Force=L3 onForceStop
 * - 卸载安全：取消 follow-up 流，迟到 setState 不写回
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import * as Lucide from 'lucide-react';
import type { SessionAgent } from '../../store/layoutStore';
import styles from './InlineAgentPanel.module.css';
import {
  selectActiveAgentId,
  selectPanelAgentId,
  useSessionField,
} from '../../api/store-access/componentAccess';
import { buildAssistantTimeline } from '../../api/toolPresentation';
import { stripThoughtPlaceholders } from '../../api/markdownRenderLite';
import {
  normalizeAgentPanelAgentId,
  openAgentInSidePanel,
  planOpenAgentInSidePanel,
  resolveAgentPanelLabel,
  resolveAgentPanelStatusLabel,
  resolveAgentPanelTitle,
  shouldReuseAgentPanelFocus,
} from '../../api/openAgentPanel';
import { Priority } from '../../workers';
import { ComposerField } from '../chat-composer/ChatComposer';
import { ChatToolStack } from '../chat-tool-call/ChatToolCallBlock';
import { AsyncMarkdownBlock } from '../chat-message-row/AsyncMarkdownBlock';
import { useAgentPanel } from '../../hooks/useAgentStream';
import { useAgentToolApproval } from '../../hooks/useAgentToolApproval';
import { Tooltip } from '../ui';

/** 内联 denser：比主列 / 侧栏默认 4 行再收一行，避免时间线被撑爆 */
const INLINE_COMPOSER_MAX_LINES = 3;

const SubagentThinkingFold: React.FC<{ thinkingText: string; isLive?: boolean }> = ({ thinkingText, isLive = false }) => {
  const [open, setOpen] = useState(false);
  const isExpanded = open || isLive;
  return (
    <details
      className={`${styles.thinkingFold} ${isExpanded ? styles.isOpen : ''}`}
      open={isExpanded}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className={styles.thinkingFoldSum}>
        <ChevronRight
          size={14}
          className={`${styles.thinkingChevron} ${isExpanded ? styles.isOpen : ''}`}
        />
        <span className={styles.thinkingFoldLabel}>
          思考
        </span>
      </summary>
      <div className={styles.thinkingFoldBody}>
        {thinkingText.trim()}
      </div>
    </details>
  );
};

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
  const [isComposing, setIsComposing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const reactId = useId();
  const bodyDomId = `inline-agent-body-${reactId}`;
  const labelDomId = `inline-agent-label-${reactId}`;

  /** 侧栏焦点订阅：reuse / 「已在侧栏」徽标 */
  const panelAgentId = useSessionField(selectPanelAgentId);
  const activeAgentId = useSessionField(selectActiveAgentId);

  // 实时 agent 数据（O(1) sessionsById）
  const live =
    useSessionField(
      (s) => s.sessionsById[parentSessionId]?.agents?.find((a) => a.id === agent.id),
    ) || agent;

  const agentIdNorm = normalizeAgentPanelAgentId(live.id) ?? '';
  const running = live.status === 'running';

  const {
    handleSend,
    handleStop,
    handleForceStop,
    sending,
    stopping,
    expandedTools,
    onToggleTool,
  } = useAgentPanel({
    parentSessionId,
    agentId: live.id,
    isRunning: running,
    useDaemonSync: false,
  });

  /** 标题 / 短标签 / 状态：与 openAgentPanel 纯函数同轨（中文） */
  const displayTitle = useMemo(
    () => resolveAgentPanelTitle(live),
    [live],
  );
  const displayLabel = useMemo(
    () => resolveAgentPanelLabel(live),
    [live],
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

  const messages = live.messages || [];
  const msgCount = messages.length;
  const pendingTools = messages.reduce((n, m) => {
    return n + (m.toolCalls || []).filter((t) => t.status === 'pending_approval').length;
  }, 0);

  const canSend = Boolean(input.trim()) && !sending && !stopping && Boolean(agentIdNorm);

  /** 空消息列表：按状态中文文案 */
  const emptyStreamCopy = useMemo(() => {
    if (running) return '子智能体执行中，产出将显示在此…';
    if (live.status === 'failed') return '暂无消息（运行失败）。可在下方重试。';
    if (live.status === 'stopped') return '暂无消息（已停止）。可继续发送以开启新一轮。';
    if (live.summary?.trim()) {
      return `暂无消息记录。摘要：${live.summary.trim().slice(0, 80)}`;
    }
    return '暂无消息。可在下方继续对话。';
  }, [running, live.status, live.summary]);

  const sideOpenTitle = sideFocused ? '重聚焦子智能体' : '在侧栏打开子智能体';
  const sideOpenAria = sideFocused
    ? `重聚焦子智能体「${displayTitle}」`
    : `在侧栏打开子智能体「${displayTitle}」`;
  const regionAria = `${displayTitle}，${statusLabel}`;

  return (
    <div
      className={`${styles.inlineAgent} ${styles.inlineAgentDense} ${open ? `${styles.isOpen} is-open` : ''} ${
        live.status === 'running'
          ? `${styles.inlineAgentRunning} is-running`
          : live.status === 'failed'
          ? `${styles.inlineAgentFailed} is-failed`
          : live.status === 'stopped'
          ? `${styles.inlineAgentStopped} is-stopped`
          : ''
      }${sideFocused ? ` ${styles.sideFocused} side-focused` : ''} inline-agent inline-agent-dense inline-agent-panel`}
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
                className={`${styles.agentHeadBtn} ${styles.inlineAgentStopBtn}`}
                aria-label={stopping ? '正在停止子智能体' : '停止子智能体'}
                aria-busy={stopping || undefined}
                disabled={stopping}
                onClick={(e) => { e.stopPropagation(); e.preventDefault(); handleStop(live.summary); }}
              >
                <Lucide.Square size={11} fill="currentColor" aria-hidden />
              </button>
            </Tooltip>
          ) : null}
          <Tooltip content={sideOpenTitle}>
            <button
              type="button"
              className={`${styles.agentHeadBtn} ${sideFocused ? styles.isActive : ''}`}
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
            {running ? (
              <Tooltip content="停止生成">
                <button
                  type="button"
                  className={`${styles.inlineAgentLink} ${styles.inlineAgentLinkStop}`}
                  aria-label="停止生成"
                  aria-busy={stopping || undefined}
                  disabled={stopping}
                  onClick={() => handleStop(live.summary)}
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
              </div>
            ) : (
              messages.map((msg) => (
                <div key={msg.id} className={`${styles.inlineAgentMsg} inline-agent-msg--${msg.sender}`}>
                  {msg.sender === 'user' ? (
                    <div className={styles.inlineAgentUserPrompt}>{msg.text}</div>
                  ) : (
                    <>
                      {msg.thinking &&
                      msg.thinking.trim() &&
                      msg.thinking !== '正在处理…' &&
                      !looksLikeShellDump(msg.thinking) ? (
                        <SubagentThinkingFold thinkingText={msg.thinking} isLive={running} />
                      ) : null}
                      {(() => {
                        // Stream = plain text (no per-token HTML). Completed = Rust async.
                        const isStreamingMsg =
                          msg.status === 'processing' || msg.status === 'queued';
                        const mdPriority = isStreamingMsg
                          ? Priority.Normal
                          : Priority.High;
                        const timeline = buildAssistantTimeline(msg);
                        if (!timeline.length && (msg.text || '').trim()) {
                          const fallback = stripThoughtPlaceholders(msg.text || '');
                          if (!fallback.trim()) return null;
                          return (
                            <div className="msg-assistant-text">
                              <AsyncMarkdownBlock
                                text={fallback}
                                isStreaming={isStreamingMsg}
                                priority={mdPriority}
                              />
                            </div>
                          );
                        }
                        const textItems = timeline.filter((i) => i.kind === 'text');
                        const lastTextKey = textItems.length
                          ? textItems[textItems.length - 1]!.key
                          : null;
                        return timeline.map((item) => {
                          if (item.kind === 'text') {
                            const body = stripThoughtPlaceholders(item.content || '');
                            if (!body.trim()) return null;
                            const streaming =
                              isStreamingMsg && item.key === lastTextKey;
                            return (
                              <div key={item.key} className="msg-timeline-text">
                                <AsyncMarkdownBlock
                                  text={body}
                                  isStreaming={streaming}
                                  priority={mdPriority}
                                />
                              </div>
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
                const text = input.trim();
                if (text) {
                  setInput('');
                  void handleSend(text);
                }
              }}
              canSend={canSend}
              disabled={sending || stopping || !agentIdNorm}
              isComposing={isComposing}
              setIsComposing={setIsComposing}
              isProcessing={running}
              onStop={() => handleStop(live.summary)}
              onForceStop={() => handleForceStop(live.summary)}
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
              className={styles.noOutlineComposer}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
};

/** 避免把 shell 表格拉进「思考」折叠 */
function looksLikeShellDump(s: string): boolean {
  return (
    /FullName|LastWriteTime|Mode\s+Length|----/.test(s) ||
    (/^[A-Za-z]:\\/.test(s.trim()) && s.includes('\n') && s.split('\n').length > 4)
  );
}
