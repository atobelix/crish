/**
 * 顶栏单一「活动」入口与复合面板（M-08 刚性裁决 · 工具流重构 P6 / W6）。
 *
 * 核心契约：
 * 1. 顶栏单一入口：承载子智能体、后台工具长任务、后台 Shell 进程三类异步任务；
 * 2. 三态显隐与去术语化：
 *    - 活跃态：5px 蓝色脉冲点 + 极简文案「活动」（或「活动 · N」）+ 下拉箭头；
 *    - 静止历史态：bot 图标 +「N 个子代理」+ 下拉箭头；
 *    - 纯无态：物理返回 null，顶栏面包屑前置分隔符同步隐藏；
 * 3. 绝无分区 0（当前回合秒表彻底砍除，主回合同步流式绝不在此计时）；
 * 4. 按需时钟：仅在面板展开且存在运行中条目时启动 500ms 走字定时器，面板关闭立即销毁。
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { SessionAgent } from '../../store/types';
import { Button, IconButton, PulseDot, SmartExpandablePanel, Tooltip } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';
import { formatDurationLabel } from '../../api/tool-presentation/processMetricsEngine';
import {
  agentIdentity,
  resolveAgentIdentities,
} from '../../api/tool-presentation/agentIdentity';
import { mapSubagentRoleWireName } from '../../api/tool-presentation/agentRoleLabel';
import { AgentIdentityBadge } from '../agent-card/AgentIdentityBadge';
import {
  useSessionActivity,
  type SessionActivityData,
} from './useSessionActivity';
import styles from './SubagentHeaderPanel.module.css';

export interface SubagentHeaderPanelProps {
  agents?: SessionAgent[];
  parentSessionId: string;
  activity?: SessionActivityData;
}

export const SubagentHeaderPanel: React.FC<SubagentHeaderPanelProps> = ({
  agents: externalAgents,
  parentSessionId,
  activity: externalActivity,
}) => {
  const hookActivity = useSessionActivity(parentSessionId, externalAgents);
  const activity = externalActivity ?? hookActivity;

  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // 按需时钟：仅在面板展开（open === true）且存在运行中项时激活 500ms 定时器
  useEffect(() => {
    if (!open || activity.runningCount === 0) return;
    setNow(Date.now());
    const timerId = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timerId);
  }, [open, activity.runningCount]);

  // 纯无态：物理返回 null，不留空占位
  if (activity.mode === 'hidden') {
    return null;
  }

  const identities = resolveAgentIdentities(activity.agents);

  const trigger = (
    <Tooltip
      content={activity.mode === 'active' ? '查看活动详情' : '查看子代理状态'}
      side="bottom"
    >
      <Button
        variant="ghost"
        type="button"
        id="bcAgentCapsule"
        className={`${styles.agentTrigger} ${styles.breadcrumbAgentBtn} breadcrumb-agent-btn ${
          activity.mode === 'active' ? styles.isRunning : ''
        }`}
        aria-label="展开子代理状态面板"
        aria-expanded={open}
      >
        {activity.mode === 'active' ? (
          <>
            <PulseDot
              size={5}
              className={`${styles.liveDot} ${styles.agentLiveDot} agent-live-dot`}
            />
            <span
              className={`${styles.triggerText} ${styles.bcAgentText} bc-agent-text`}
            >
              {activity.runningCount > 1
                ? `活动 · ${activity.runningCount}`
                : '活动'}
            </span>
            <span className={styles.compactText} aria-hidden="true">
              ● {activity.runningCount}
            </span>
          </>
        ) : (
          <>
            <AppIcon
              name={activity.agents.length > 0 ? 'bot' : 'terminal'}
              size={13}
              className={styles.botIcon}
              aria-hidden="true"
            />
            <span
              className={`${styles.triggerText} ${styles.bcAgentText} bc-agent-text`}
            >
              {activity.agents.length > 0
                ? `${activity.agents.length} 个子代理`
                : `${(activity.shellTasks?.length ?? 0) + (activity.toolTasks?.length ?? 0)} 个后台任务`}
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

  return (
    <SmartExpandablePanel
      trigger={trigger}
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          setNow(Date.now());
          void activity.refreshToolTasks?.();
        }
      }}
      position={{ align: 'start', side: 'bottom', sideOffset: 6 }}
      className={styles.activityMenuPanel}
    >
      <div
        className={styles.activityMenuPanel}
        role="dialog"
        aria-label="当前会话活动与后台任务"
      >
        {/* 分区 1：子智能体 */}
        {activity.agents.length > 0 && (
          <div className={styles.section}>
            <div className={styles.sectionTitle}>子智能体</div>
            <div className={styles.itemList}>
              {activity.agents.map((agent) => {
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
                const agentTask =
                  anyAgent.task || agent.summary || agent.description;
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

                const duration = isRunning
                  ? `已运行 ${formatDurationLabel(Math.max(0, now - (agent.startedAt || now)))}`
                  : agent.endedAt && agent.startedAt
                    ? `用时 ${formatDurationLabel(Math.max(0, agent.endedAt - agent.startedAt))}`
                    : '';

                const identity =
                  identities.get(agent.id) ?? agentIdentity(agent.id);

                return (
                  <div
                    key={agent.id}
                    className={styles.itemRow}
                    onClick={() => activity.openAgent(agent.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        activity.openAgent(agent.id);
                      }
                    }}
                  >
                    <div className={styles.itemLeading}>
                      <AgentIdentityBadge identity={identity} size={14} />
                    </div>
                    <div className={styles.itemInfo}>
                      <div className={styles.itemHeaderLine}>
                        <span className={styles.itemName}>{agentName}</span>
                        <span
                          className={`${styles.statusBadge} ${badgeClass}`}
                        >
                          {statusBadgeText}
                        </span>
                      </div>
                      <div className={styles.itemSubline}>
                        {agentTask ? (
                          <span className={styles.itemTask}>{agentTask}</span>
                        ) : null}
                        {duration ? (
                          <span className={styles.itemDuration}>
                            {duration}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {isRunning ? (
                      <div
                        className={styles.itemAction}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Tooltip content="终止子代理">
                          <IconButton
                            aria-label="终止子代理"
                            size="xs"
                            variant="ghost"
                            className={styles.killBtn}
                            onClick={() => activity.killAgent(agent.id)}
                            icon={<AppIcon name="x-octagon" size={12} />}
                          />
                        </Tooltip>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 分区 2：后台工具长任务 */}
        {activity.toolTasks.length > 0 && (
          <div className={styles.section}>
            <div className={styles.sectionTitle}>后台工具</div>
            <div className={styles.itemList}>
              {activity.toolTasks.map((task) => {
                const isQueued =
                  task.state === 'queued' || task.startedAtMs === null;
                const duration = isQueued
                  ? '排队中'
                  : `已运行 ${formatDurationLabel(Math.max(0, now - (task.startedAtMs ?? now)))}`;
                return (
                  <div key={task.callId} className={styles.itemRow}>
                    <div className={styles.itemLeading}>
                      <AppIcon
                        name="cpu"
                        size={14}
                        className={styles.toolIcon}
                      />
                    </div>
                    <div className={styles.itemInfo}>
                      <div className={styles.itemHeaderLine}>
                        <span className={styles.itemName}>
                          {task.toolName || task.callId}
                        </span>
                        <span
                          className={`${styles.statusBadge} ${
                            isQueued ? styles.badgeIdle : styles.badgeRunning
                          }`}
                        >
                          {isQueued ? '排队中' : '运行中'}
                        </span>
                      </div>
                      <div className={styles.itemSubline}>
                        <span className={styles.itemDuration}>
                          {duration}
                        </span>
                      </div>
                    </div>
                    <div
                      className={styles.itemAction}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Tooltip content="取消后台任务">
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className={styles.cancelBtn}
                          onClick={() => activity.cancelToolTask(task.callId)}
                        >
                          取消
                        </Button>
                      </Tooltip>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 分区 3：后台命令 */}
        {activity.activeShellTasks.length > 0 && (
          <div className={styles.section}>
            <div className={styles.sectionTitle}>后台命令</div>
            <div className={styles.itemList}>
              {activity.activeShellTasks.map((task) => {
                const duration = task.startedAt
                  ? `已运行 ${formatDurationLabel(Math.max(0, now - task.startedAt))}`
                  : task.durationMs
                    ? `用时 ${formatDurationLabel(task.durationMs)}`
                    : '';
                return (
                  <div key={task.id} className={styles.itemRow}>
                    <div className={styles.itemLeading}>
                      <AppIcon
                        name="terminal"
                        size={14}
                        className={styles.shellIcon}
                      />
                    </div>
                    <div className={styles.itemInfo}>
                      <div className={styles.itemHeaderLine}>
                        <span className={styles.itemName}>
                          {task.summary ||
                            task.label ||
                            task.command ||
                            task.id}
                        </span>
                        <span
                          className={`${styles.statusBadge} ${styles.badgeRunning}`}
                        >
                          运行中
                        </span>
                      </div>
                      <div className={styles.itemSubline}>
                        {duration ? (
                          <span className={styles.itemDuration}>
                            {duration}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div
                      className={styles.itemAction}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Tooltip content="终止后台进程">
                        <IconButton
                          aria-label="终止后台进程"
                          size="xs"
                          variant="ghost"
                          className={styles.killBtn}
                          onClick={() => activity.cancelShellTask(task.id)}
                          icon={<AppIcon name="x-octagon" size={12} />}
                        />
                      </Tooltip>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </SmartExpandablePanel>
  );
};

export { SubagentHeaderPanel as ActivityHeaderPanel };
