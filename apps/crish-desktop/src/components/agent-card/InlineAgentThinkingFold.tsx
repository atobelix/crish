/**
 * 子智能体「思考」折叠（InlineAgentPanel 时间线内联折叠，F1-β 拆分）。
 * 纯展示：open 受控于本地状态；isLive（运行中）时强制展开。
 * 零 hook / 零 store，仅消费 props。
 */
import React, { useState } from 'react';

import styles from './InlineAgentPanel.module.css';
import { AppIcon } from '../ui/icons/index';

export const InlineAgentThinkingFold: React.FC<{
  thinkingText: string;
  isLive?: boolean;
}> = ({ thinkingText, isLive = false }) => {
  const [open, setOpen] = useState(false);
  const isExpanded = open || isLive;
  return (
    <details
      className={`${styles.thinkingFold} ${isExpanded ? styles.isOpen : ''}`}
      open={isExpanded}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className={styles.thinkingFoldSum}>
        <AppIcon name="chevron-right" size={14}
          className={`${styles.thinkingChevron} ${isExpanded ? styles.isOpen : ''}`} />
        <span className={styles.thinkingFoldLabel}>思考</span>
      </summary>
      <div className={styles.thinkingFoldBody}>{thinkingText.trim()}</div>
    </details>
  );
};
