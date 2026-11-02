/**
 * AgentCard 详情头部：身份标 + 标题 + 状态徽标 + 失败/待批/时长提示 +
 * 反向定位/停止/关闭按钮。
 * 从 AgentCard.tsx 拆出以收敛单文件行数。
 */
import React, { useMemo } from 'react';
import styles from './AgentCard.module.css';
import { Button, Tooltip } from '@/components/ui';

import type { SessionAgent } from '../../store/types';
import { useI18n } from '../../i18n';
import { AgentStatusChip } from './AgentStatusChip';
import { AgentIdentityBadge } from './AgentIdentityBadge';
import { resolveErrorKindLabel } from '../../api/continuity/continuityNotices';
import {
  locateSubagentDispatchInFlow,
  resolveAgentCardTitle,
} from '../../api/openAgentPanel';
import {
  agentIdentity,
  resolveAgentIdentities,
} from '../../api/tool-presentation/agentIdentity';
import { countPendingApprovals, formatAgentDuration } from './agentCardUtils';
import { AppIcon } from '@/components/ui/icons';

export interface AgentCardHeaderProps {
  agent: SessionAgent;
  /** 本会话全部 agents（身份分配按会话口径；缺省退化为单 agent 分配） */
  agents?: SessionAgent[];
  /** 所属主会话 id（反向定位锚点解析用） */
  sessionId?: string;
  running: boolean;
  embedded?: boolean;
  hasSiblings: boolean;
  onClose?: () => void;
  onBackToBrowse: () => void;
  onStop: () => void;
}

export const AgentCardHeader: React.FC<AgentCardHeaderProps> = ({
  agent,
  agents,
  sessionId,
  running,
  embedded,
  hasSiblings,
  onClose,
  onBackToBrowse,
  onStop,
}) => {
  const { t } = useI18n();
  const titleName = resolveAgentCardTitle(agent);
  const durationLabel = formatAgentDuration(agent);
  const pendingApproval = countPendingApprovals(agent);
  // 与流内分派卡同一会话级身份分配（同 agent 同色同标）
  const identity = useMemo(() => {
    const list = agents && agents.length > 0 ? agents : [agent];
    return (
      resolveAgentIdentities(list).get(agent.id) ?? agentIdentity(agent.id)
    );
  }, [agents, agent]);

  return (
    <header
      className={`${styles.agentCardHeader} ${styles.agentCardHeaderSlim} side-panel-toolbar`}
    >
      <div className={styles.agentCardTitleRow}>
        {/* 返回浏览列表：不关 tab、不碰主列；browse 会触发 id 清空 → 清草稿 */}
        {hasSiblings ? (
          <Tooltip content="返回子智能体列表">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={styles.agentCardBtn}
              aria-label="返回子智能体列表"
              icon={<AppIcon name="chevron-left" size={14} aria-hidden />}
              onClick={onBackToBrowse}
            />
          </Tooltip>
        ) : null}
        <AgentIdentityBadge identity={identity} size={14} />
        {agent.mode || durationLabel || agent.summary?.trim() ? (
          <Tooltip
            content={[
              agent.mode ? `模式：${agent.mode}` : '',
              durationLabel || '',
              (agent.summary || '').trim().slice(0, 120),
            ]
              .filter(Boolean)
              .join(' · ')}
          >
            <span className={styles.agentCardTitle}>{titleName}</span>
          </Tooltip>
        ) : (
          <span className={styles.agentCardTitle}>{titleName}</span>
        )}
        <AgentStatusChip status={agent.status} mode={agent.mode} />
        {agent.capabilityMode === 'read-only' ? (
          <Tooltip content={t('chat.agentCard.readOnlyHint')}>
            <span className={styles.agentCardBadge} role="status">
              {t('chat.agentCard.readOnly')}
            </span>
          </Tooltip>
        ) : null}
        {agent.modelOverride ? (
          <Tooltip
            content={t('chat.agentCard.modelBound', {
              model: agent.modelOverride,
            })}
          >
            <span className={styles.agentCardBadge}>{agent.modelOverride}</span>
          </Tooltip>
        ) : null}
        {agent.resumable && !running ? (
          <Tooltip content={t('chat.agentCard.resumeHint')}>
            <span className={styles.agentCardBadge} role="status">
              {t('chat.agentCard.resumable')}
            </span>
          </Tooltip>
        ) : null}
        {/* D8 §3.7.1 失败态摘要徽标（与 InlineAgentPanel 失败卡片同源：
            errorKind/retries 由 recovery-escalated 事件投影） */}
        {agent.status === 'failed' &&
        (resolveErrorKindLabel(agent.errorKind) || (agent.retries ?? 0) > 0) ? (
          <span
            className={styles.agentCardBadge}
            role="status"
            aria-label={t('chat.agentCard.failureReason', {
              reason:
                resolveErrorKindLabel(agent.errorKind) ||
                t('chat.agentCard.unknown'),
            })}
          >
            {resolveErrorKindLabel(agent.errorKind)}
            {(agent.retries ?? 0) > 0
              ? t('chat.agentCard.retries', { count: agent.retries })
              : ''}
          </span>
        ) : null}
        {pendingApproval > 0 ? (
          <span
            className={styles.agentCardBadge}
            role="status"
            aria-label={t('chat.agentCard.pendingTools', {
              count: pendingApproval,
            })}
          >
            {pendingApproval} 待批
          </span>
        ) : null}
        {durationLabel ? (
          <Tooltip content={running ? '已运行时长' : '总时长'}>
            <span
              className={styles.agentCardBadge}
              aria-label={
                running ? `已运行 ${durationLabel}` : `用时 ${durationLabel}`
              }
            >
              {durationLabel}
            </span>
          </Tooltip>
        ) : null}
      </div>
      <div className={styles.agentCardActions}>
        {/* 反向定位（R4b）：滚动主列到本 agent 的流内分派卡并闪烁高亮 */}
        <Tooltip content={t('chat.agentCard.locateInFlow')}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.agentCardBtn}
            aria-label={t('chat.agentCard.locateInFlowAria')}
            icon={<AppIcon name="locate" size={14} aria-hidden />}
            onClick={() => {
              locateSubagentDispatchInFlow(agent.id, {
                sessionId: sessionId || agent.parentSessionId || undefined,
              });
            }}
          />
        </Tooltip>
        {running ? (
          <Tooltip content="停止子智能体">
            <Button
              type="button"
              variant="danger"
              size="sm"
              className={styles.agentCardBtn}
              aria-label="停止子智能体"
              icon={
                <AppIcon
                  name="square"
                  size={12}
                  fill="currentColor"
                  aria-hidden
                />
              }
              onClick={onStop}
            />
          </Tooltip>
        ) : null}
        {onClose ? (
          <Tooltip content={embedded ? '返回' : '关闭侧栏'}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={styles.agentCardBtn}
              aria-label={embedded ? '返回' : '关闭侧栏'}
              icon={
                embedded ? (
                  <AppIcon name="chevron-left" size={14} aria-hidden />
                ) : (
                  <AppIcon name="x" size={14} aria-hidden />
                )
              }
              onClick={onClose}
            />
          </Tooltip>
        ) : null}
      </div>
    </header>
  );
};
