import React from 'react';
import styles from '../AgentCard.module.css';
import { Tooltip } from '../Tooltip';
import type { SessionAgent } from '../../store/layoutStore';
import { STATUS_LABEL } from './agentCardUtils';

/** 状态芯片：统一中文 + a11y role/status */
export function AgentStatusChip({
  status,
  mode,
  compact,
}: {
  status: SessionAgent['status'];
  mode?: string;
  /** 列表行更紧时不读冗长 title */
  compact?: boolean;
}) {
  const label = STATUS_LABEL[status] || '未知';
  const modeHint = mode ? `模式：${mode}` : undefined;
  return (
    <Tooltip content={compact ? label : modeHint || label}>
      <span
        className={`${styles.agentCardBadge} ${styles['agentCardBadge' + status.charAt(0).toUpperCase() + status.slice(1)] || ''}`}
        role="status"
        data-agent-status={status}
        aria-label={`状态：${label}${mode ? `，${modeHint}` : ''}`}
      >
        {label}
      </span>
    </Tooltip>
  );
}
