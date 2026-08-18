/**
 * 主对话时间线内的协作 agent 块（像工具行一样嵌在流里，可展开）。
 *
 * 契约（再扫）：
 * - 打开详情只走 openAgentInSidePanel（侧栏 only，永不 setActiveAgentId / 新窗口）
 * - 开面板前用 planOpenAgentInSidePanel 纯规划（空 id reject；reuse 感知）
 * - 输入区 ComposerField dense + maxLines=3，壳与侧栏 AgentCard 同轨
 * - 运行中可停止：折叠头 / 工具条 / Composer 默认 Stop=L2；Composer Force=L3 onForceStop
 * - 卸载安全：取消 follow-up 流，迟到 setState 不写回
 * - F1-β 拆分：壳收敛全部 store hook / 编排职责；Header/Timeline/Composer/
 *   Approval/ThinkingFold 为纯 props 展示子件（零 hook / 零 store）
 */
import React, {
  useCallback,
  useEffect,
  useId,
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
  resolveAgentPanelLabel,
  resolveAgentPanelStatusLabel,
  resolveAgentPanelTitle,
  shouldReuseAgentPanelFocus,
} from '../../api/openAgentPanel';
import { useAgentPanel } from '../../hooks/useAgentStream';
import { useAgentToolApproval } from '../../hooks/useAgentToolApproval';
import { getCompositionRoot } from '../../app/compositionRoot';
import {
  isAnyRecoveryCommandReady,
  isRecoveryCommandReady,
  killAllSubagents,
  killSubagent,
  resumeSubagent,
} from '../../api/subagentRecoveryApi';
import { resolveErrorKindLabel } from '../../api/continuity/continuityNotices';
import { InlineAgentPanelHeader } from './InlineAgentPanelHeader';
import { InlineAgentTimeline } from './InlineAgentTimeline';
import { InlineAgentComposer } from './InlineAgentComposer';

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
  const [open, setOpen] = useState(
    Boolean(defaultOpen ?? agent.status === 'running')
  );
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
    useSessionField((s) =>
      s.sessionsById[parentSessionId]?.agents?.find((a) => a.id === agent.id)
    ) || agent;

  const agentIdNorm = normalizeAgentPanelAgentId(live.id) ?? '';
  const running = live.status === 'running';

  const {
    handleSend,
    handleStopGeneration,
    handleForceCancelGeneration,
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
  const displayTitle = useMemo(() => resolveAgentPanelTitle(live), [live]);
  const displayLabel = useMemo(() => resolveAgentPanelLabel(live), [live]);
  const statusLabel = resolveAgentPanelStatusLabel(live.status);

  /**
   * 侧栏已聚焦本 agent 且主列干净 → reuse 态（无需换 id）。
   * activeAgentId 脏时强制非 reuse，开侧栏会清主列。
   */
  const sideFocused = shouldReuseAgentPanelFocus(
    panelAgentId,
    agentIdNorm,
    activeAgentId
  );

  // 审批：与主对话同路径（ApprovalAskCard 二次确认 + remember）
  const { approvalBusy, onApprovalAllow, onApprovalDeny } =
    useAgentToolApproval(parentSessionId, live.id);

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
    [live, parentSessionId, panelAgentId, activeAgentId]
  );

  const messages = live.messages || [];
  const msgCount = messages.length;
  const pendingTools = messages.reduce((n, m) => {
    return (
      n +
      (m.toolCalls || []).filter((t) => t.status === 'pending_approval').length
    );
  }, 0);

  const canSend =
    Boolean(input.trim()) && !sending && !stopping && Boolean(agentIdNorm);

  /** 空消息列表：按状态中文文案 */
  const emptyStreamCopy = useMemo(() => {
    if (running) return '子智能体执行中，产出将显示在此…';
    if (live.status === 'failed') return '暂无消息（运行失败）。可在下方重试。';
    if (live.status === 'stopped')
      return '暂无消息（已停止）。可继续发送以开启新一轮。';
    if (live.summary?.trim()) {
      return `暂无消息记录。摘要：${live.summary.trim().slice(0, 80)}`;
    }
    return '暂无消息。可在下方继续对话。';
  }, [running, live.status, live.summary]);

  // D8 §3.7.1 失败态卡片增强：错误 kind（kebab-case→中文映射）/重试次数 +
  // resume/kill/kill_all 恢复按钮。数据源 = recovery-escalated 事件投影
  // （subagentRunId 匹配）+ run 终态 error + subagent-ended summary 三级回退；
  // 命令面未注册期（D4 未落地）按钮隐藏（能力降级，不渲染幽灵按钮）。
  const isFailed = live.status === 'failed';
  const errorKindLabel = isFailed ? resolveErrorKindLabel(live.errorKind) : '';
  const retries = isFailed ? live.retries : undefined;
  const recoveryReady = isFailed && isAnyRecoveryCommandReady();
  const resumeReady = isFailed && isRecoveryCommandReady('resume');
  const killReady = isFailed && isRecoveryCommandReady('kill');
  const killAllReady = isFailed && isRecoveryCommandReady('kill_all');

  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState('');

  const runRecoveryAction = useCallback(
    async (action: 'resume' | 'kill' | 'kill_all', errorMsg: string) => {
      if (recoveryBusy) return;
      setRecoveryBusy(true);
      setRecoveryError('');
      try {
        if (action === 'resume') {
          // resume = fork 新 run（D4 resume_subagent，三态上下文继承，
          // 16/16/1 守卫由引擎执行）；卡片回 running 由 subagent-started
          // 事件面刷新，不在此写死
          await resumeSubagent(parentSessionId, live.id, live.summary);
        } else if (action === 'kill') {
          await killSubagent(parentSessionId, live.id, 'ui-kill');
          getCompositionRoot()
            .session.getState()
            .patchSessionAgent(parentSessionId, live.id, {
              status: 'stopped',
              summary: '已关闭',
              endedAt: Date.now(),
            });
        } else {
          await killAllSubagents(parentSessionId, 'ui-kill-all');
        }
      } catch (e) {
        setRecoveryError(e instanceof Error ? e.message : String(e));
        console.error(errorMsg, e);
      } finally {
        setRecoveryBusy(false);
      }
    },
    [parentSessionId, live.id, live.summary, recoveryBusy]
  );

  const sideOpenTitle = sideFocused ? '重聚焦子智能体' : '在侧栏打开子智能体';
  const sideOpenAria = sideFocused
    ? `重聚焦子智能体「${displayTitle}」`
    : `在侧栏打开子智能体「${displayTitle}」`;
  const regionAria = `${displayTitle}，${statusLabel}`;

  /** 停止/强制停止统一绑 summary（折叠头 / 工具条 / Composer 三入口共用） */
  const stopAgent = useCallback(() => {
    handleStopGeneration(live.summary);
  }, [handleStopGeneration, live.summary]);

  const forceCancelAgent = useCallback(() => {
    handleForceCancelGeneration(live.summary);
  }, [handleForceCancelGeneration, live.summary]);

  /** Composer 发送：trim 后清空输入并走 follow-up 流 */
  const sendToAgent = useCallback(() => {
    const text = input.trim();
    if (text) {
      setInput('');
      void handleSend(text);
    }
  }, [input, handleSend]);

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
      <InlineAgentPanelHeader
        open={open}
        onToggleOpen={() => setOpen((v) => !v)}
        status={live.status}
        running={running}
        stopping={stopping}
        onStop={stopAgent}
        displayLabel={displayLabel}
        statusLabel={statusLabel}
        pendingTools={pendingTools}
        mode={live.mode}
        msgCount={msgCount}
        summary={live.summary}
        sideFocused={sideFocused}
        sideOpenTitle={sideOpenTitle}
        sideOpenAria={sideOpenAria}
        sideDisabled={!agentIdNorm}
        onOpenSide={openInSideOnly}
        labelDomId={labelDomId}
        bodyDomId={bodyDomId}
      />

      {open ? (
        <div
          className={styles.inlineAgentBody}
          id={bodyDomId}
          role="group"
          aria-label={`${displayTitle} 详情`}
        >
          <InlineAgentTimeline
            bodyRef={bodyRef}
            live={live}
            running={running}
            stopping={stopping}
            onStop={stopAgent}
            parentSessionId={parentSessionId}
            expandedTools={expandedTools}
            onToggleTool={onToggleTool}
            approval={{
              approvalBusy,
              onApprovalAllow,
              onApprovalDeny,
              pendingTools,
            }}
            emptyStreamCopy={emptyStreamCopy}
            recovery={{
              isFailed,
              errorKindLabel,
              retries,
              recoveryReady,
              resumeReady,
              killReady,
              killAllReady,
              recoveryBusy,
              recoveryError,
            }}
            onRecoveryAction={runRecoveryAction}
          />

          <InlineAgentComposer
            value={input}
            onChange={setInput}
            onSend={sendToAgent}
            onStop={stopAgent}
            onForceStop={forceCancelAgent}
            canSend={canSend}
            disabled={sending || stopping || !agentIdNorm}
            isComposing={isComposing}
            setIsComposing={setIsComposing}
            isProcessing={running}
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
          />
        </div>
      ) : null}
    </div>
  );
};
