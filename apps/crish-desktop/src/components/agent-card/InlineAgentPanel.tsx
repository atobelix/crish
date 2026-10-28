/**
 * 主对话时间线内的协作 subagent 徽章（时间线行内徽章 §5.3 / reference subagent.css）。
 *
 * 契约：
 * - 废除内嵌完整输入框与上帝控件，改为时间线行内徽章：`<title> subagent 工作中 1.8秒`（带 5px 呼吸灯与双行链路追踪摘要）；
 * - 打开详情分流走 openAgentInSidePanel（侧栏 only，永不 setActiveAgentId / 新窗口）；
 * - 展开消息区具备独立 LEFT vertical rail，已完成消息走 MarkdownBlockItem
 *   封口分支（Rust 异步 HTML），未封口消息走活跃尾块分支（流式直写）。
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { SessionAgent } from '../../store/types';
import styles from './InlineAgentPanel.module.css';
import {
  selectActiveAgentId,
  selectPanelAgentId,
  useSessionField,
} from '../../store/storeAccess';
import {
  normalizeAgentPanelAgentId,
  openAgentInSidePanel,
  planOpenAgentInSidePanel,
  resolveAgentPanelTitle,
  resolveAgentPanelStatusLabel,
  shouldReuseAgentPanelFocus,
} from '../../api/openAgentPanel';
import { Priority } from '../../workers';
import { MarkdownBlockItem } from '../chat-message-row/MarkdownBlockItem';
import {
  isRecoveryCommandReady,
  killSubagent,
  resumeSubagent,
} from '../../api/subagentRecoveryApi';
import { resolveErrorKindLabel } from '../../api/continuity/continuityNotices';
import { Button } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';

export interface InlineAgentPanelProps {
  agent: SessionAgent;
  parentSessionId: string;
  /** 默认折叠，运行中可展开 */
  defaultOpen?: boolean;
}

export const InlineAgentPanel: React.FC<InlineAgentPanelProps> = ({
  agent,
  parentSessionId,
  defaultOpen,
}) => {
  // 折叠态只由 props 决定（面板内没有展开/折叠交互），无需 state
  const open = Boolean(defaultOpen);
  const [liveSec, setLiveSec] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  /** 侧栏焦点订阅：reuse / 「已在侧栏」徽标 */
  const panelAgentId = useSessionField(selectPanelAgentId);
  const activeAgentId = useSessionField(selectActiveAgentId);

  // 实时 agent 数据（O(1) sessionsById）
  const live =
    useSessionField((s) =>
      s.sessionsById[parentSessionId]?.agents?.find((a) => a.id === agent.id)
    ) || agent;

  const running = live.status === 'running';

  useEffect(() => {
    if (!running) {
      setLiveSec(0);
      return;
    }
    const start = live.startedAt || Date.now();
    const tick = () => {
      setLiveSec(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [running, live.startedAt]);

  const displayTitle = useMemo(() => resolveAgentPanelTitle(live), [live]);
  const statusLabel = resolveAgentPanelStatusLabel(live.status);

  const statusText = useMemo(() => {
    if (running) {
      return liveSec > 0 ? `工作中 ${liveSec}s` : '工作中';
    }
    if (live.status === 'completed') return '已就绪';
    if (live.status === 'failed') return '执行失败';
    if (live.status === 'stopped') return '已停止';
    return statusLabel || '就绪';
  }, [running, liveSec, live.status, statusLabel]);

  // 链路追踪摘要（第二行：如「已扫描 12 个文件 -> 命中 2 个冲突点」或 summary / 最新消息）
  const traceText = useMemo(() => {
    if (live.summary?.trim()) return live.summary.trim();
    const msgs = live.messages || [];
    if (msgs.length > 0) {
      const last = msgs[msgs.length - 1];
      if (last?.text?.trim()) {
        const line = last.text.trim().split('\n')[0] || '';
        return line.slice(0, 80);
      }
    }
    return '';
  }, [live.summary, live.messages]);

  const sideFocused = shouldReuseAgentPanelFocus(
    panelAgentId,
    normalizeAgentPanelAgentId(live.id) ?? '',
    activeAgentId
  );

  /**
   * 侧栏 only 出口：点击行内徽章直接在右侧面板打开/聚焦
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
      if (plan.action === 'reject') return;
      if (plan.action !== 'focus' || plan.setActiveAgentId !== false) return;

      openAgentInSidePanel(id, { sessionId: parentSessionId });
    },
    [live, parentSessionId, panelAgentId, activeAgentId]
  );

  const isFailed = live.status === 'failed';
  const errorKindLabel = isFailed ? resolveErrorKindLabel(live.errorKind) : '';
  const resumeReady = isFailed && isRecoveryCommandReady('resume');
  const killReady = isFailed && isRecoveryCommandReady('kill');

  const [recoveryBusy, setRecoveryBusy] = useState(false);

  const runRecoveryAction = useCallback(
    async (action: 'resume' | 'kill') => {
      if (recoveryBusy) return;
      setRecoveryBusy(true);
      try {
        if (action === 'resume') {
          await resumeSubagent(parentSessionId, live.id, live.summary);
        } else {
          await killSubagent(parentSessionId, live.id, 'ui-kill');
        }
      } catch (e) {
        console.error('Subagent recovery error', e);
      } finally {
        setRecoveryBusy(false);
      }
    },
    [parentSessionId, live.id, live.summary, recoveryBusy]
  );

  const messages = live.messages || [];

  return (
    <div
      className={`${styles.flowSubagent} ${running ? 'is-running' : ''} ${open ? 'is-open' : ''} ${sideFocused ? 'side-focused' : ''} flow-subagent`}
      data-agent-id={live.id}
      data-agent-open-target="side-panel-only"
      data-side-focused={sideFocused ? '1' : '0'}
      data-status={live.status}
      role="region"
      aria-label={`${displayTitle}，${statusText}`}
    >
      {/* Line 1: 闪电图标 + 标题 + 运行状态与 5px 呼吸绿点 */}
      <Button
        variant="ghost"
        type="button"
        className={`${styles.flowSubagentLine1} flow-subagent__line1`}
        onClick={openInSideOnly}
        aria-label={`${displayTitle}，${statusText}`}
      >
        <span
          className={`${styles.flowSubagentIcon} flow-subagent__icon`}
          aria-hidden
        >
          <AppIcon name="zap" size={13} aria-hidden />
        </span>
        <span className={`${styles.flowSubagentTitle} flow-subagent__title`}>
          {displayTitle}
        </span>
        <span className={`${styles.flowSubagentStatus} flow-subagent__status`}>
          {running ? (
            <span
              className={`${styles.flowSubagentDot} flow-subagent__dot`}
              aria-hidden
            />
          ) : null}
          <span>{statusText}</span>
        </span>
      </Button>

      {/* Line 2: 双行链路追踪摘要（缩进对齐 padding-left: 22px） */}
      {traceText ? (
        <div className={`${styles.flowSubagentLine2} flow-subagent__line2`}>
          <div className={`${styles.flowSubagentTraces} flow-subagent__traces`}>
            <span className={`${styles.flowSubagentCol} flow-subagent__col`}>
              <span
                className={`${styles.flowSubagentTraceLead} flow-subagent__trace-lead`}
              >
                ›
              </span>
              <span
                className={`${styles.flowSubagentTrace} flow-subagent__trace is-live`}
              >
                {traceText}
              </span>
            </span>
          </div>
        </div>
      ) : null}

      {/* 展开消息区（若外部传入 defaultOpen=true 或展开），带左轨线与 MarkdownBlockItem */}
      {open ? (
        <div className={`${styles.flowSubagentPanel} flow-subagent__panel`}>
          <div
            ref={bodyRef}
            className={`${styles.flowSubagentPanelInner} flow-subagent__panel-inner`}
          >
            {messages.map((m) => {
              // 活跃尾块契约（回归修复）：MarkdownBlockItem 仅在
              //   isActiveTail = isStreaming && isLast && !isSealed
              // 时进入流式 Markdown 分支（data-sealed="false" / data-streaming="true"
              // + 只注入解析器生成的 HTML）；否则落入封口分支等待异步 HTML。
              // 本面板每条消息各挂一个独立根块，未封口者即该根的唯一尾块，
              // 故 isLast 必须跟随 isSealed 取反。历史实现恒传 isLast={false}
              // ⇒ processing 消息的 isActiveTail 恒 false ⇒ 子代理实时正文
              // 渲染为空容器（旧 AsyncMarkdownBlock 在 isStreaming 下直接渲染
              // 纯文本，换用 MarkdownBlockItem 后异步渲染可见性丢失）。
              const isSealed = m.status !== 'processing';
              return (
                <div key={m.id} className={styles.inlineAgentMsg}>
                  <MarkdownBlockItem
                    text={m.text || ''}
                    isSealed={isSealed}
                    isLast={!isSealed}
                    isStreaming={!isSealed}
                    priority={Priority.Low}
                  />
                </div>
              );
            })}
            {isFailed && (
              <div className={styles.inlineAgentRecovery}>
                <span className={styles.inlineAgentFailKind}>
                  {errorKindLabel || '执行异常'}
                </span>
                {resumeReady && (
                  <Button
                    variant="ghost"
                    type="button"
                    className={styles.inlineAgentLinkResume}
                    onClick={() => runRecoveryAction('resume')}
                  >
                    重试恢复
                  </Button>
                )}
                {killReady && (
                  <Button
                    variant="ghost"
                    type="button"
                    className={styles.inlineAgentLinkKill}
                    onClick={() => runRecoveryAction('kill')}
                  >
                    关闭
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
};
