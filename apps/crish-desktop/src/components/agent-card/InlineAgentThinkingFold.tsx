/**
 * 子智能体「思考」折叠（InlineAgentPanel 时间线内联折叠，F1-β 拆分）。
 * 展示组件：折叠状态由本地控制；isLive（运行中）时强制展开，正文交由共享 Markdown 渲染器呈现。
 */
import React, { useState } from 'react';

import styles from './InlineAgentPanel.module.css';
import { AppIcon } from '../ui/icons/index';
import { StreamingMarkdownView } from '../chat-message-row/StreamingMarkdownView';

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
      <div
        className={styles.thinkingFoldBody}
        data-testid="inline-agent-thinking-body"
      >
        <StreamingMarkdownView
          text={thinkingText.trim()}
          isStreaming={isLive}
          messageId="inline-agent-thinking"
        />
      </div>
    </details>
  );
};
