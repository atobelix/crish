/**
 * InlineAgentPanel 审批域（F1-β 拆分，纯展示 + props 契约）：
 * - InlineAgentApprovalProps：审批回调组（allow/deny/busy/待批计数），
 *   由壳组件从 useAgentToolApproval 收敛后传入时间线（ChatToolStack 审批接线）。
 * - InlineAgentApprovalHint：正文工具栏「有 N 项待确认」提示。
 * 组件零 hook / 零 store，纯 props 消费 view model。
 */
import React from 'react';
import styles from './InlineAgentPanel.module.css';

/** 审批回调组（签名对齐 useAgentToolApproval / ChatToolStack） */
export interface InlineAgentApprovalProps {
  approvalBusy: boolean;
  onApprovalAllow: (toolId: string, msgId: string, remember?: boolean) => void;
  onApprovalDeny: (toolId: string, msgId: string) => void;
  pendingTools: number;
}

/** 正文工具栏待确认提示（pendingTools > 0 时渲染） */
export const InlineAgentApprovalHint: React.FC<{
  pendingTools: number;
}> = ({ pendingTools }) => {
  if (pendingTools <= 0) return null;
  return (
    <span className={styles.inlineAgentToolbarHint} role="status">
      有 {pendingTools} 项待确认
    </span>
  );
};
