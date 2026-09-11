/**
 * AgentCard 详情头部：标题 + 状态徽标 + 失败/待批/时长提示 + 停止/关闭按钮。
 * 从 AgentCard.tsx 拆出以收敛单文件行数。
 */
import React from 'react';
import styles from './AgentCard.module.css';
import { Button, Tooltip } from '../ui';

import type { SessionAgent } from '../../store/types';
import { AgentStatusChip } from './AgentStatusChip';
import { resolveErrorKindLabel } from '../../api/continuity/continuityNotices';
import {
  agentDisplayName,
  countPendingApprovals,
  formatAgentDuration,
} from './agentCardUtils';
import { AppIcon } from '../ui/icons/index';

export interface AgentCardHeaderProps {
  agent: SessionAgent;
  running: boolean;
  embedded?: boolean;
  hasSiblings: boolean;
  onClose?: () => void;
  onBackToBrowse: () => void;
  onStop: () => void;
}

export const AgentCardHeader: React.FC<AgentCardHeaderProps> = ({
  agent,
  running,
  embedded,
  hasSiblings,
  onClose,
  onBackToBrowse,
  onStop,
}) => {
  const titleName = agentDisplayName(agent);
  const durationLabel = formatAgentDuration(agent);
  const pendingApproval = countPendingApprovals(agent);

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
        <AppIcon name="bot" size={14} aria-hidden />
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
          <span className={styles.agentCardTitle}>{titleName}</span>
        </Tooltip>
        <AgentStatusChip status={agent.status} mode={agent.mode} />
        {/* D8 §3.7.1 失败态摘要徽标（与 InlineAgentPanel 失败卡片同源：
            errorKind/retries 由 recovery-escalated 事件投影） */}
        {agent.status === 'failed' &&
        (resolveErrorKindLabel(agent.errorKind) ||
          (agent.retries ?? 0) > 0) ? (
          <Tooltip
            content={[
              resolveErrorKindLabel(agent.errorKind),
              (agent.retries ?? 0) > 0 ? `已重试 ${agent.retries} 次` : '',
            ]
              .filter(Boolean)
              .join('；')}
          >
            <span
              className={styles.agentCardBadge}
              role="status"
              aria-label={`失败原因：${
                resolveErrorKindLabel(agent.errorKind) || '未知'
              }`}
            >
              {resolveErrorKindLabel(agent.errorKind)}
              {(agent.retries ?? 0) > 0 ? ` · ${agent.retries} 次重试` : ''}
            </span>
          </Tooltip>
        ) : null}
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
              aria-label={
                running
                  ? `已运行 ${durationLabel}`
                  : `用时 ${durationLabel}`
              }
            >
              {durationLabel}
            </span>
          </Tooltip>
        ) : null}
      </div>
      <div className={styles.agentCardActions}>
        {running ? (
          <Tooltip content="停止子智能体">
            <Button
              type="button"
              variant="danger"
              size="sm"
              className={styles.agentCardBtn}
              aria-label="停止子智能体"
              icon={
                <AppIcon name="square" size={12} fill="currentColor" aria-hidden />
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
