import React from 'react';
import styles from './ChatMessageRow.module.css';
import { ChatToolStack, type ChatToolStackSharedProps } from '../chat-tool-call/ChatToolCallBlock';
import type { ToolRenderItem } from '../../api/toolPresentation';
import { buildToolStackHostProps, shouldHostToolStack } from './chatMessageRowUtils';

export interface MessageToolCallsSectionProps {
  items: ToolRenderItem[] | undefined | null;
  msgId: string;
  toolStackProps: ChatToolStackSharedProps;
}

export const MessageToolCallsSection: React.FC<MessageToolCallsSectionProps> = ({
  items,
  msgId,
  toolStackProps,
}) => {
  if (!shouldHostToolStack(items)) return null;

  const host = buildToolStackHostProps(items!, msgId, toolStackProps);

  return (
    <div className={styles.timelineTools}>
      <ChatToolStack {...host} />
    </div>
  );
};
