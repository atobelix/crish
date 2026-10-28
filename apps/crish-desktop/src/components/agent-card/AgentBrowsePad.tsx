import React, { useMemo } from 'react';
import styles from './AgentCard.module.css';
import { Button, Tooltip } from '@/components/ui';

import { openAgentInSidePanel } from '../../api/openAgentPanel';
import { useI18n } from '../../i18n';
import {
  selectActiveSessionId,
  selectSessionsById,
  useSessionField,
} from '../../store/storeAccess';
import { AgentStatusChip } from './AgentStatusChip';
import {
  STATUS_LABEL,
  agentDisplayName,
  countPendingApprovals,
  formatAgentDuration,
  sortAgentsForBrowse,
} from './agentCardUtils';
import { AppIcon } from '@/components/ui/icons';

/**
 * Agent 侧栏空态 / 浏览列表：仅浏览本会话已有、由主 AI 拉起的子 agent。
 * 无「人类协作任务」表单；创建只发生在 run_subagent。
 * 打开详情仅 openAgentInSidePanel（侧栏 only）。
 */
export function AgentBrowsePad({
  parentSessionId,
  onClose,
  embedded,
}: {
  parentSessionId?: string | null;
  onClose?: (() => void) | undefined;
  embedded?: boolean | undefined;
}) {
  const { t } = useI18n();
  const sessionsById = useSessionField(selectSessionsById);
  const activeSessionId = useSessionField(selectActiveSessionId);
  const parentId = parentSessionId || activeSessionId;
  const parent = parentId ? sessionsById[parentId] : undefined;
  const agents = useMemo(() => parent?.agents || [], [parent]);
  const sorted = useMemo(() => sortAgentsForBrowse(agents), [agents]);
  const runningCount = useMemo(
    () => agents.filter((a) => a.status === 'running').length,
    [agents]
  );
  const pendingTotal = useMemo(
    () => agents.reduce((n, a) => n + countPendingApprovals(a), 0),
    [agents]
  );

  return (
    <div
      className={`${styles.agentCard} ${styles.agentCardLaunch} ${styles.agentCardDense}`}
      data-agent-side-only="1"
      data-agent-panel="browse"
      role="region"
      aria-label="协作体聊天列表"
    >
      <header
        className={`${styles.agentCardHeader} ${styles.agentCardHeaderSlim}`}
      >
        <div className={styles.agentCardTitleRow}>
          <AppIcon name="bot" size={14} aria-hidden />
          <span className={styles.agentCardTitle}>聊天</span>
          {agents.length > 0 ? (
            <Tooltip content={`共 ${agents.length} 个`}>
              <span
                className={styles.agentCardBadge}
                aria-label={`共 ${agents.length} 个子智能体`}
              >
                {agents.length}
              </span>
            </Tooltip>
          ) : null}
          {runningCount > 0 ? (
            <Tooltip content="运行中">
              <span
                className={`${styles.agentCardBadge} ${styles.agentCardBadgeRunning}`}
                role="status"
                aria-label={`${runningCount} 个运行中`}
              >
                {runningCount} 运行
              </span>
            </Tooltip>
          ) : null}
          {pendingTotal > 0 ? (
            <Tooltip content="待审批工具">
              <span
                className={styles.agentCardBadge}
                role="status"
                aria-label={`${pendingTotal} 项待审批`}
              >
                {pendingTotal} 待批
              </span>
            </Tooltip>
          ) : null}
        </div>
        {onClose ? (
          <Tooltip content={embedded ? '返回' : '关闭侧栏'}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={styles.agentCardBtn}
              aria-label={embedded ? '返回' : '关闭侧栏'}
              onClick={onClose}
              icon={
                embedded ? (
                  <AppIcon name="chevron-left" size={14} aria-hidden />
                ) : (
                  <AppIcon name="x" size={14} aria-hidden />
                )
              }
            />
          </Tooltip>
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
              <AppIcon
                name="bot"
                size={13}
                className={styles.skeletonBotIcon}
                aria-hidden
              />
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
          <div
            className={styles.agentLaunchList}
            role="list"
            aria-label="已拉起智能体列表"
          >
            {sorted.map((a) => {
              const name = agentDisplayName(a);
              const pending = countPendingApprovals(a);
              const dur = formatAgentDuration(a);
              const titleBits = [
                name,
                STATUS_LABEL[a.status],
                a.mode ? t('chat.agentBrowse.modeValue', { mode: a.mode }) : '',
                a.capabilityMode === 'read-only'
                  ? t('chat.agentBrowse.readOnly')
                  : '',
                a.modelOverride
                  ? t('chat.agentBrowse.modelValue', {
                      model: a.modelOverride,
                    })
                  : '',
                a.resumable ? t('chat.agentBrowse.resumable') : '',
                pending
                  ? t('chat.agentBrowse.pendingCount', { count: pending })
                  : '',
                dur || '',
                (a.summary || '').trim().slice(0, 80),
              ].filter(Boolean);
              return (
                <Tooltip key={a.id} content={titleBits.join(' · ')}>
                  <Button
                    variant="ghost"
                    type="button"
                    role="listitem"
                    className={styles.agentLaunchItem}
                    data-agent-id={a.id}
                    data-agent-status={a.status}
                    aria-label={`${name}，${STATUS_LABEL[a.status]}${
                      pending ? `，${pending} 项待批` : ''
                    }。在侧栏打开`}
                    onClick={() => {
                      // 侧栏 only：禁止主列全屏 / 新会话 ghost
                      openAgentInSidePanel(a.id, {
                        sessionId: parentId || undefined,
                      });
                    }}
                  >
                    <AppIcon name="bot" size={13} aria-hidden />
                    <span className={styles.agentLaunchItemT}>{name}</span>
                    {pending > 0 ? (
                      <Tooltip
                        content={t('chat.agentBrowse.pendingCount', {
                          count: pending,
                        })}
                      >
                        <span className={styles.agentCardBadge} aria-hidden>
                          {t('chat.agentBrowse.pendingBadge')}
                        </span>
                      </Tooltip>
                    ) : null}
                    {a.resumable ? (
                      <Tooltip content={t('chat.agentBrowse.resumeHint')}>
                        <span className={styles.agentCardBadge} role="status">
                          {t('chat.agentBrowse.resumable')}
                        </span>
                      </Tooltip>
                    ) : null}
                    <AgentStatusChip status={a.status} mode={a.mode} compact />
                  </Button>
                </Tooltip>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
