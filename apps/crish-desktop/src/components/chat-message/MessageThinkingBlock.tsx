import React from 'react';
import { MessageThinkingSection } from '../chat-message-row/MessageThinkingSection';
import { type budgetDomText } from '../../api/messageWindow';

export interface MessageThinkingBlockProps {
  showThinking: boolean;
  isThinkingMsg: boolean;
  thinkingSeconds: number;
  thinkingText: string;
  thinkingBodyId: string;
  thinkingOpen: boolean;
  setThinkingOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  thinkingBudget: ReturnType<typeof budgetDomText>;
}

export const MessageThinkingBlock: React.FC<MessageThinkingBlockProps> = React.memo((props) => {
  return <MessageThinkingSection {...props} />;
});

MessageThinkingBlock.displayName = 'MessageThinkingBlock';
