import React, { useMemo } from 'react';

import type { SessionAgent } from '../../store/types';
import { countRunningSubagents } from './unitChromeLabel';
import { Button, IconButton, Tooltip } from '@/components/ui';
import { openAgentInSidePanel } from '../../api/openAgentPanel';
import { killSubagent } from '../../api/subagentRecoveryApi';
import {
  agentIdentity,
  resolveAgentIdentities,
} from '../../api/tool-presentation/agentIdentity';
import { mapSubagentRoleWireName } from '../../api/tool-presentation/agentRoleLabel';
import { AgentIdentityBadge } from '../agent-card/AgentIdentityBadge';
import { SmartExpandablePanel, type MenuItem } from '@/components/ui';
import styles from './SubagentHeaderPanel.module.css';
import { AppIcon } from '@/components/ui/icons';

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
      <Button
        variant="ghost"
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
            <AppIcon
              name="bot"
              size={13}
              className={styles.botIcon}
              aria-hidden="true"
            />
            <span
              className={`${styles.triggerText} ${styles.bcAgentText} bc-agent-text`}
            >
              {agents.length} 个子代理
            </span>
          </>
        )}
        <AppIcon
          name="chevron-down"
          size={11}
          className={`${styles.bcChevron} bc-chevron`}
          aria-hidden="true"
        />
      </Button>
    </Tooltip>
  );

  const menuItems = useMemo<MenuItem[]>(() => {
    // 会话级身份分配（与流内卡/侧栏头部/团队板同口径：同 agent 同色同标）；
    // 身份标占菜单图标位，状态仍由 badge 文本承载。
    const identities = resolveAgentIdentities(agents);
    return agents.map((agent) => {
      const anyAgent = agent as Partial<SessionAgent> & {
        name?: string;
        role?: string;
        task?: string;
      };
      const agentName =
        anyAgent.name ||
        anyAgent.role ||
        (agent.displayLabel
          ? mapSubagentRoleWireName(agent.displayLabel)
          : '') ||
        agent.description ||
        agent.mode ||
        '子代理';
      const agentTask = anyAgent.task || agent.summary || agent.description;
      const isRunning = agent.status === 'running';

      let statusBadgeText = '空闲';
      let badgeClass = styles.badgeIdle;

      if (isRunning) {
        statusBadgeText = '运行中';
        badgeClass = styles.badgeRunning;
      } else if (agent.status === 'completed') {
        statusBadgeText = '已完成';
        badgeClass = styles.badgeCompleted;
      } else if (agent.status === 'failed') {
        statusBadgeText = '失败';
        badgeClass = styles.badgeFailed;
      } else if (agent.status === 'stopped') {
        statusBadgeText = '已停止';
        badgeClass = styles.badgeStopped;
      }

      const identity = identities.get(agent.id) ?? agentIdentity(agent.id);

      return {
        id: agent.id,
        label: agentName,
        sublabel: agentTask,
        icon: <AgentIdentityBadge identity={identity} size={14} />,
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
