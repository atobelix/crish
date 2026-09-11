import React, { useMemo } from 'react';

import type { SessionAgent } from '../../store/types';
import { countRunningSubagents } from './unitChromeLabel';
import { IconButton, Tooltip } from '../ui';
import { openAgentInSidePanel } from '../../api/openAgentPanel';
import { killSubagent } from '../../api/subagentRecoveryApi';
import {
  SmartExpandablePanel,
  type MenuItem,
} from '../ui/SmartExpandablePanel';
import styles from './SubagentHeaderPanel.module.css';
import { AppIcon } from '../ui/icons/index';

export interface SubagentHeaderPanelProps {
  agents: SessionAgent[];
  parentSessionId: string;
}

export const SubagentHeaderPanel: React.FC<SubagentHeaderPanelProps> = ({
  agents,
  parentSessionId,
}) => {
  const runningCount = useMemo(() => countRunningSubagents(agents), [agents]);

  const trigger = (
    <Tooltip content="查看子 Agent 状态" side="bottom">
      <button
        type="button"
        id="bcAgentCapsule"
        className={`${styles.agentTrigger} ${styles.breadcrumbAgentBtn} breadcrumb-agent-btn ${
          runningCount > 0 ? styles.isRunning : ''
        }`}
        aria-label="展开子代理状态面板"
      >
        {runningCount > 0 ? (
          <>
            <span
              className={`${styles.liveDot} ${styles.agentLiveDot} agent-live-dot`}
              aria-hidden="true"
            />
            <span
              className={`${styles.triggerText} ${styles.bcAgentText} bc-agent-text`}
            >
              {runningCount} 个运行中
            </span>
          </>
        ) : (
          <>
            <AppIcon name="bot" size={13} className={styles.botIcon} aria-hidden="true" />
            <span
              className={`${styles.triggerText} ${styles.bcAgentText} bc-agent-text`}
            >
              {agents.length} 个子代理
            </span>
          </>
        )}
        <AppIcon name="chevron-down" size={11}
          className={`${styles.bcChevron} bc-chevron`}
          aria-hidden="true" />
      </button>
    </Tooltip>
  );

  const menuItems = useMemo<MenuItem[]>(() => {
    return agents.map((agent) => {
      const anyAgent = agent as Partial<SessionAgent> & {
        name?: string;
        role?: string;
        task?: string;
      };
      const agentName =
        anyAgent.name ||
        anyAgent.role ||
        agent.displayLabel ||
        agent.description ||
        agent.mode ||
        '子代理';
      const agentTask = anyAgent.task || agent.summary || agent.description;
      const isRunning = agent.status === 'running';

      let statusBadgeText = '空闲';
      let statusIcon = <AppIcon name="bot" size={14} />;
      let badgeClass = styles.badgeIdle;

      if (isRunning) {
        statusBadgeText = '运行中';
        statusIcon = <AppIcon name="play" size={14} className={styles.pulseGreen} />;
        badgeClass = styles.badgeRunning;
      } else if (agent.status === 'completed') {
        statusBadgeText = '已完成';
        statusIcon = <AppIcon name="check-circle" size={14} />;
        badgeClass = styles.badgeCompleted;
      } else if (agent.status === 'failed') {
        statusBadgeText = '失败';
        statusIcon = <AppIcon name="x-circle" size={14} />;
        badgeClass = styles.badgeFailed;
      } else if (agent.status === 'stopped') {
        statusBadgeText = '已停止';
        statusIcon = <AppIcon name="octagon-alert" size={14} />;
        badgeClass = styles.badgeStopped;
      }

      return {
        id: agent.id,
        label: agentName,
        sublabel: agentTask,
        icon: statusIcon,
        badge: statusBadgeText,
        badgeClassName: badgeClass,
        searchKeywords: `${agentName} ${agentTask || ''}`,
        onSelect: () => {
          openAgentInSidePanel(agent.id, { sessionId: parentSessionId });
        },
        trailingAction: isRunning ? (
          <Tooltip content="终止子代理">
            <IconButton
              aria-label="终止子代理"
              size="xs"
              variant="ghost"
              className={styles.killBtn}
              onClick={(e) => {
                e.stopPropagation();
                killSubagent(parentSessionId, agent.id);
              }}
              icon={<AppIcon name="x-octagon" size={12} />}
            />
          </Tooltip>
        ) : undefined,
      };
    });
  }, [agents, parentSessionId]);

  return (
    <SmartExpandablePanel
      trigger={trigger}
      items={menuItems}
      position={{ align: 'start', side: 'bottom', sideOffset: 6 }}
      className={styles.subagentMenuPanel}
    />
  );
};
