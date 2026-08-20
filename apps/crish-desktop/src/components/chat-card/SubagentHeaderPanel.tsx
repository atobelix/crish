import React, { useMemo } from 'react';
import { Bot, ChevronDown, XOctagon } from 'lucide-react';
import type { SessionAgent } from '../../store/types';
import { countRunningSubagents } from './unitChromeLabel';
import { Menu, IconButton, Tooltip } from '../ui';
import { openAgentInSidePanel } from '../../api/openAgentPanel';
import { killSubagent } from '../../api/subagentRecoveryApi';
import styles from './SubagentHeaderPanel.module.css';

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
    <button
      type="button"
      id="bcAgentCapsule"
      className={`${styles.agentTrigger} ${styles.breadcrumbAgentBtn} breadcrumb-agent-btn ${runningCount > 0 ? styles.isRunning : ''}`}
      aria-label="展开子代理状态面板"
      title="查看子 Agent 状态"
    >
      {runningCount > 0 ? (
        <>
          <span className={`${styles.liveDot} ${styles.agentLiveDot} agent-live-dot`} aria-hidden="true" />
          <span className={`${styles.triggerText} ${styles.bcAgentText} bc-agent-text`}>{runningCount} 个运行中</span>
        </>
      ) : (
        <>
          <Bot size={13} className={styles.botIcon} aria-hidden="true" />
          <span className={`${styles.triggerText} ${styles.bcAgentText} bc-agent-text`}>{agents.length} 个子代理</span>
        </>
      )}
      <ChevronDown size={11} className={`${styles.bcChevron} bc-chevron`} aria-hidden="true" />
    </button>
  );

  return (
    <Menu
      trigger={trigger}
      position={{ align: 'start', side: 'bottom', sideOffset: 6 }}
      panel={{ contentClassName: styles.subagentMenuPanel }}
      options={agents.map((agent) => {
        const anyAgent = agent as Partial<SessionAgent> & {
          name?: string;
          role?: string;
        };
        const label =
          anyAgent.name ||
          anyAgent.role ||
          agent.displayLabel ||
          agent.description ||
          agent.id;
        return {
          id: agent.id,
          label,
        };
      })}
      renderItem={(opt) => {
        const agent = agents.find((a) => a.id === opt.id);
        if (!agent) return null;
        const isRunning = agent.status === 'running';
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

        return (
          <div key={agent.id} className={styles.agentItemRow}>
            <div
              className={styles.agentInfo}
              onClick={() =>
                openAgentInSidePanel(agent.id, {
                  sessionId: parentSessionId,
                })
              }
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openAgentInSidePanel(agent.id, {
                    sessionId: parentSessionId,
                  });
                }
              }}
            >
              <div className={styles.agentHeaderLine}>
                <span className={styles.agentName}>{agentName}</span>
                <span
                  className={`${styles.statusBadge} ${styles[agent.status || 'idle'] || ''}`}
                >
                  {isRunning
                    ? '运行中'
                    : agent.status === 'completed'
                      ? '已完成'
                      : agent.status === 'failed'
                        ? '失败'
                        : agent.status === 'stopped'
                          ? '已停止'
                          : '空闲'}
                </span>
              </div>
              {agentTask && (
                <div className={styles.agentTask}>{agentTask}</div>
              )}
            </div>
            {isRunning && (
              <Tooltip content="终止子代理">
                <IconButton
                  size="xs"
                  variant="ghost"
                  className={styles.killBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    killSubagent(parentSessionId, agent.id);
                  }}
                  aria-label="终止子代理"
                  icon={<XOctagon size={12} />}
                />
              </Tooltip>
            )}
          </div>
        );
      }}
    />
  );
};
