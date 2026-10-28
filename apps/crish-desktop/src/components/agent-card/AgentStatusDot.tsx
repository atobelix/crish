/**
 * AgentTeamBoard 状态点 / 旋转 spinner 子组件。
 * 从 AgentTeamBoard.tsx 拆出以收敛单文件行数。
 */
import React from 'react';
import styles from './AgentCard.module.css';
import { ICON_STROKE } from '@/components/ui/icons';
import { Tooltip } from '@/components/ui';
import type { SessionAgent } from '../../store/types';

export const AgentStatusDot: React.FC<{
  status: SessionAgent['status'];
}> = ({ status }) => {
  if (status === 'running') {
    return (
      <span className={styles.statusSpinner} aria-hidden="true">
        <svg className={styles.spinnerSvg} viewBox="0 0 24 24">
          <circle
            className={styles.spinnerCircle}
            cx="12"
            cy="12"
            r="10"
            stroke="var(--text-tertiary)"
            strokeWidth={ICON_STROKE.heavy}
            fill="none"
            strokeLinecap="round"
            strokeDasharray="40, 10"
          />
        </svg>
      </span>
    );
  }
  let dotColor = 'var(--text-tertiary)'; // default/stopped
  let label = '已停止';
  if (status === 'completed') {
    dotColor = 'var(--accent-green)'; // green dot
    label = '已完成';
  } else if (status === 'failed') {
    dotColor = 'var(--accent-orange)'; // orange dot
    label = '有错误';
  }
  return (
    <Tooltip content={label}>
      <span
        className={styles.statusDot}
        style={{ backgroundColor: dotColor }}
        aria-hidden="true"
      />
    </Tooltip>
  );
};
