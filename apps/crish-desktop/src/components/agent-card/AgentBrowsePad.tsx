import React, { useMemo } from 'react';
import styles from './AgentCard.module.css';
import { Tooltip } from '../Tooltip';
import * as Lucide from 'lucide-react';
import { browseAgentSidePanel, openAgentInSidePanel } from '../../api/openAgentPanel';
import {
  selectActiveSessionId,
  selectSessionsById,
  useSessionField,
} from '../../api/store-access/componentAccess';
import { AgentStatusChip } from './AgentStatusChip';
import {
  STATUS_LABEL,
  agentDisplayName,
  countPendingApprovals,
  formatAgentDuration,
  sortAgentsForBrowse,
} from './agentCardUtils';

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
            <button
              type="button"
              className={styles.agentCardBtn}
              aria-label={embedded ? '返回' : '关闭侧栏'}
              onClick={onClose}
            >
              {embedded ? <Lucide.ChevronLeft size={14} aria-hidden /> : <Lucide.X size={14} aria-hidden />}
            </button>
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
                <Tooltip key={a.id} content={titleBits.join(' · ')}>
                  <button
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
                    <Lucide.Bot size={13} strokeWidth={1.75} aria-hidden />
                    <span className={styles.agentLaunchItemT}>{name}</span>
                    {pending > 0 ? (
                      <Tooltip content={`${pending} 项待批`}>
                        <span
                          className={styles.agentCardBadge}
                          aria-hidden
                        >
                          待批
                        </span>
                      </Tooltip>
                    ) : null}
                    <AgentStatusChip status={a.status} mode={a.mode} compact />
                  </button>
                </Tooltip>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
