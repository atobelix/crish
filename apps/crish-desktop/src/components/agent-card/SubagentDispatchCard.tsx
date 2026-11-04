/**
 * 流内子 agent 分派消息卡（R4b · 取代 InlineAgentPanel 徽章 + 展开体）。
 *
 * 契约（用户裁决 2026-11-01 晚）：
 * - 分派是回合流内一条**独立消息卡**（一行一卡、自成一条消息）：从过程段的
 *   工具分组中提取（buildToolRenderItems 不入组 + MessageToolCallsSection
 *   提取渲染），按发生顺序立在原派发位置，多个并行分派各自成卡、不做汇总行；
 * - 卡面 = [身份标（agentIdentity 色点 + 几何标号，彩色只准出现在此）] +
 *   标题（displayLabel → description → mode → id 短码，wire 名经呈现层映射）+
 *   状态 + 第二行信息（运行中：当前动作 + 已完成 N/M 步 + 已用时；完成：
 *   结论首行 + 用时 · 共 N 个工具；失败：错误分类 + 摘要，恢复动作上卡面）+
 *   待批数（仅 arbiter=user 口径，见 countPendingApprovals）；
 * - **整卡一次点击 → 侧边栏打开该 agent 的全量详情**（openAgentInSidePanel，
 *   只写 panelAgentId、主列永不被覆盖）；流内**没有展开体**——子 agent 的
 *   消息/工具调用明细只在侧栏 AgentCard 呈现，本组件绝不渲染 agent.messages
 *   正文或其 toolCalls（负断言由测试锁定）；
 * - 卡片无可开合区域，不存在条件渲染卸载问题；定位锚点
 *   data-parent-tool-call-id 供侧栏「在对话中定位」反向滚动 + 闪烁。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { SessionAgent } from '../../store/types';
import styles from './SubagentDispatchCard.module.css';
import {
  selectActiveAgentId,
  selectPanelAgentId,
  useSessionField,
} from '../../store/storeAccess';
import {
  normalizeAgentPanelAgentId,
  openAgentInSidePanel,
  planOpenAgentInSidePanel,
  resolveAgentCardTitle,
  resolveAgentPanelStatusLabel,
  shouldReuseAgentPanelFocus,
} from '../../api/openAgentPanel';
import {
  agentIdentity,
  resolveAgentIdentities,
} from '../../api/tool-presentation/agentIdentity';
import { toolHumanLabel } from '../../api/toolPresentation';
import { AgentIdentityBadge } from './AgentIdentityBadge';
import { countPendingApprovals, formatAgentDuration } from './agentCardUtils';
import { toolProgress } from './agentTeamBoardUtils';
import {
  isRecoveryCommandReady,
  killSubagent,
  resumeSubagent,
} from '../../api/subagentRecoveryApi';
import { resolveErrorKindLabel } from '../../api/continuity/continuityNotices';
import { useRevealEntrance } from '../chat-tool-call/useRevealEntrance';
import { useI18n } from '../../i18n';
import { formatDurationLabel } from '../../api/tool-presentation/processMetricsEngine';
import { Button } from '@/components/ui';

export interface SubagentDispatchCardProps {
  agent: SessionAgent;
  parentSessionId: string;
  /** 派发本次子 agent 的父工具调用 id（反向定位锚点）；缺省取 agent.parentToolCallId */
  parentToolCallId?: string;
}

/** 当前动作：最近一个 running 工具的人话标签；无 running 时取最后一个工具 */
function currentActionLabel(agent: SessionAgent): string {
  let lastAny = '';
  const msgs = agent.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const tcs = msgs[i]?.toolCalls || [];
    for (let j = tcs.length - 1; j >= 0; j--) {
      const tc = tcs[j]!;
      if (tc.status === 'running') return toolHumanLabel(tc);
      if (!lastAny) lastAny = toolHumanLabel(tc);
    }
    if (lastAny) break;
  }
  return lastAny;
}

/** 结论首行：summary 优先，否则最后一条消息正文首行（截 120 字） */
function conclusionFirstLine(agent: SessionAgent): string {
  const summary = (agent.summary || '').trim();
  if (summary) return summary.split('\n')[0] || '';
  const msgs = agent.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const text = (msgs[i]?.text || '').trim();
    if (text) {
      const line = text.split('\n')[0] || '';
      return line.length > 120 ? `${line.slice(0, 120)}…` : line;
    }
  }
  return '';
}

export const SubagentDispatchCard: React.FC<SubagentDispatchCardProps> = ({
  agent,
  parentSessionId,
  parentToolCallId,
}) => {
  const { t } = useI18n();
  const [liveSec, setLiveSec] = useState(0);
  const [recoveryBusy, setRecoveryBusy] = useState(false);

  /** 侧栏焦点订阅：reuse / 「已在侧栏」视觉态 */
  const panelAgentId = useSessionField(selectPanelAgentId);
  const activeAgentId = useSessionField(selectActiveAgentId);

  // 实时 agent 数据（O(1) sessionsById）
  const live =
    useSessionField((s) =>
      s.sessionsById[parentSessionId]?.agents?.find((a) => a.id === agent.id)
    ) || agent;

  // 会话级身份分配（与侧栏头部/团队板/顶栏同一 resolveAgentIdentities 口径，
  // 保证四面同 agent 同色同标；订阅整个 agents 数组以便撞色顺延实时一致）
  const siblings = useSessionField(
    (s) => s.sessionsById[parentSessionId]?.agents
  );
  const identity = useMemo(() => {
    const list = siblings && siblings.length > 0 ? siblings : [live];
    return resolveAgentIdentities(list).get(live.id) ?? agentIdentity(live.id);
  }, [siblings, live]);

  const running = live.status === 'running';

  // AN4：整卡入场（实况分派才播，与消息行/工具行同语言；历史回放直出）
  const entrance = useRevealEntrance({
    key: live.id ? `agent:${live.id}` : '',
    eventTs: live.startedAt,
  });

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
    // 活时长走字 tick 口径钉死 500ms（2026-11-02 整波收口裁定：与工具行
    // 同口径；共享格式化呈现 0.1s，500ms 为保住亚秒位走字的最粗节律）
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [running, live.startedAt]);

  const displayTitle = useMemo(() => resolveAgentCardTitle(live), [live]);
  const statusLabel = resolveAgentPanelStatusLabel(live.status);

  const statusText = useMemo(() => {
    if (running) {
      return liveSec > 0
        ? t('chat.agentCard.dispatch.statusWorkingSec', {
            // B13：时长走 formatDurationLabel 单一口径（禁止裸秒数拼装）
            duration: formatDurationLabel(liveSec * 1000),
          })
        : t('chat.agentCard.dispatch.statusWorking');
    }
    if (live.status === 'completed')
      return t('chat.agentCard.dispatch.statusReady');
    if (live.status === 'failed')
      return t('chat.agentCard.dispatch.statusFailed');
    if (live.status === 'stopped')
      return t('chat.agentCard.dispatch.statusStopped');
    return statusLabel || t('chat.agentCard.dispatch.statusIdle');
  }, [running, liveSec, live.status, statusLabel, t]);

  const progress = useMemo(() => toolProgress(live), [live]);
  const durationLabel = formatAgentDuration(live);
  const pendingApprovals = countPendingApprovals(live);

  /** 第二行（状态分工）：见文件头契约。
   * AN4 拆分呈现：运行态的「当前动作」单独成段（变更时交叉淡化），
   * 进度/用时属状态类、即时跳换不加过渡（分析 §三 #7/#8）。 */
  const line2Parts = useMemo(() => {
    if (running) {
      const rest: string[] = [];
      if (progress.total > 0) {
        rest.push(
          t('chat.agentCard.dispatch.progress', {
            done: progress.done,
            total: progress.total,
          })
        );
      }
      if (durationLabel) rest.push(durationLabel);
      return { action: currentActionLabel(live), rest: rest.join(' · ') };
    }
    if (live.status === 'completed') {
      const parts: string[] = [];
      if (durationLabel)
        parts.push(
          t('chat.agentCard.dispatch.durationUsed', { duration: durationLabel })
        );
      if (progress.total > 0)
        parts.push(
          t('chat.agentCard.dispatch.toolCount', { count: progress.total })
        );
      return { action: '', rest: parts.join(' · ') };
    }
    return { action: '', rest: '' };
  }, [running, live, progress, durationLabel, t]);

  const line2 = line2Parts.action
    ? line2Parts.rest
      ? `${line2Parts.action} · ${line2Parts.rest}`
      : line2Parts.action
    : line2Parts.rest;

  const conclusion = useMemo(
    () =>
      live.status === 'completed' || live.status === 'stopped'
        ? conclusionFirstLine(live)
        : '',
    [live]
  );

  const sideFocused = shouldReuseAgentPanelFocus(
    panelAgentId,
    normalizeAgentPanelAgentId(live.id) ?? '',
    activeAgentId
  );

  /** 侧栏 only 出口：整卡点击在右侧面板打开/聚焦该 agent（管线与旧徽章一致） */
  const openInSideOnly = useCallback(() => {
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
  }, [live, parentSessionId, panelAgentId, activeAgentId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      // 卡内按钮（恢复动作）自理键盘/点击，不冒泡触发整卡打开
      if ((e.target as HTMLElement | null)?.closest?.('button')) return;
      e.preventDefault();
      openInSideOnly();
    },
    [openInSideOnly]
  );

  const isFailed = live.status === 'failed';
  const errorKindLabel = isFailed ? resolveErrorKindLabel(live.errorKind) : '';
  const failSummary = isFailed ? conclusionFirstLine(live) : '';
  const resumeReady = isFailed && isRecoveryCommandReady('resume');
  const killReady = isFailed && isRecoveryCommandReady('kill');

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

  const anchorToolCallId =
    parentToolCallId ?? live.parentToolCallId ?? undefined;

  return (
    <div
      className={`${styles.card} ${running ? styles.isRunning : ''} ${sideFocused ? styles.sideFocused : ''}${entrance.entering ? ` ${styles.cardEnter}` : ''}`}
      data-dispatch-card="1"
      data-entering={entrance.entering ? 'true' : undefined}
      onAnimationEnd={entrance.handleAnimationEnd}
      data-agent-id={live.id}
      data-parent-tool-call-id={anchorToolCallId}
      data-agent-open-target="side-panel-only"
      data-side-focused={sideFocused ? '1' : '0'}
      data-status={live.status}
      role="button"
      tabIndex={0}
      aria-label={t('chat.agentCard.dispatch.cardAria', {
        title: displayTitle,
        status: statusText,
      })}
      onClick={openInSideOnly}
      onKeyDown={handleKeyDown}
    >
      {/* Line 1: 身份标 + 标题 + 状态（+ 待批数） */}
      <div className={styles.line1}>
        <AgentIdentityBadge identity={identity} size={14} />
        <span className={styles.title}>{displayTitle}</span>
        <span className={styles.status}>
          {running ? <span className={styles.dot} aria-hidden /> : null}
          <span>{statusText}</span>
        </span>
        {pendingApprovals > 0 ? (
          <span
            className={styles.pendingBadge}
            role="status"
            aria-label={t('chat.agentCard.dispatch.pendingAria', {
              count: pendingApprovals,
            })}
          >
            {t('chat.agentCard.dispatch.pendingCount', {
              count: pendingApprovals,
            })}
          </span>
        ) : null}
      </div>

      {/* Line 2: 运行中 = 当前动作 + 进度 + 已用时；完成 = 用时 · 工具数 */}
      {line2 ? (
        <div className={styles.line2}>
          <span className={styles.traceLead} aria-hidden>
            ›
          </span>
          <span className={styles.trace}>
            {line2Parts.action ? (
              <>
                <span key={line2Parts.action} className={styles.traceFade}>
                  {line2Parts.action}
                </span>
                {line2Parts.rest ? ' · ' : ''}
              </>
            ) : null}
            {line2Parts.rest}
          </span>
        </div>
      ) : null}

      {/* 完成/停止：结论首行（出现时同 fade-in） */}
      {conclusion ? (
        <div className={styles.line2}>
          <span className={styles.traceLead} aria-hidden>
            ›
          </span>
          <span
            key={conclusion}
            className={`${styles.trace} ${styles.traceFade}`}
          >
            {conclusion}
          </span>
        </div>
      ) : null}

      {/* 失败：错误分类 + 摘要 + 恢复动作（上卡面，不藏展开体） */}
      {isFailed ? (
        <div className={styles.line2}>
          <span className={styles.traceLead} aria-hidden>
            ›
          </span>
          <span className={styles.failKind}>
            {errorKindLabel || t('chat.agentCard.dispatch.errorFallback')}
          </span>
          {failSummary ? (
            <span className={styles.trace}>{failSummary}</span>
          ) : null}
        </div>
      ) : null}
      {isFailed && (resumeReady || killReady) ? (
        <div className={styles.recovery}>
          {resumeReady ? (
            <Button
              variant="ghost"
              type="button"
              size="sm"
              className={styles.linkResume}
              disabled={recoveryBusy}
              onClick={(e) => {
                e.stopPropagation();
                void runRecoveryAction('resume');
              }}
            >
              {t('chat.agentCard.dispatch.resume')}
            </Button>
          ) : null}
          {killReady ? (
            <Button
              variant="ghost"
              type="button"
              size="sm"
              className={styles.linkKill}
              disabled={recoveryBusy}
              onClick={(e) => {
                e.stopPropagation();
                void runRecoveryAction('kill');
              }}
            >
              {t('chat.agentCard.dispatch.kill')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
