import React from 'react';
import { MessageThinkingSection } from '../chat-message-row/MessageThinkingSection';
import { type budgetDomText } from '../../api/messageWindow';

export interface MessageThinkingBlockProps {
  showThinking: boolean;
  isThinkingMsg: boolean;
  thinkingText: string;
  thinkingBodyId: string;
  thinkingOpen: boolean;
  setThinkingOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  thinkingBudget: ReturnType<typeof budgetDomText>;
}

function thinkingBlockPropsEqual(
  prev: MessageThinkingBlockProps,
  next: MessageThinkingBlockProps
): boolean {
  return (
    prev.showThinking === next.showThinking &&
    prev.isThinkingMsg === next.isThinkingMsg &&
    prev.thinkingText === next.thinkingText &&
    prev.thinkingBodyId === next.thinkingBodyId &&
    prev.thinkingOpen === next.thinkingOpen &&
    prev.setThinkingOpen === next.setThinkingOpen &&
    prev.thinkingBudget === next.thinkingBudget
  );
}

export const MessageThinkingBlock: React.FC<MessageThinkingBlockProps> =
  React.memo((props) => {
    return <MessageThinkingSection {...props} />;
  }, thinkingBlockPropsEqual);

MessageThinkingBlock.displayName = 'MessageThinkingBlock';
