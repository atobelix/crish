import React, { lazy } from 'react';
import styles from './ChatMessageRow.module.css';
import { ChatToolStack, type ChatToolStackSharedProps } from '../chat-tool-call/ChatToolCallBlock';
import type { ToolRenderItem } from '../../api/toolPresentation';
import { buildToolStackHostProps, shouldHostToolStack } from './chatMessageRowUtils';

/**
 * 关联子 agent 行渲染器：内嵌 InlineAgentPanel（懒加载保持分包）。
 * 注入点选择：chat-tool-call 不得反向依赖 agent-card（InlineAgentPanel →
 * ChatToolStack → CompactToolRow 环形依赖），组合根在此提供渲染器。
 */
const InlineAgentPanel = lazy(() =>
  import('../agent-card/InlineAgentPanel').then((m) => ({ default: m.InlineAgentPanel }))
);

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
      <ChatToolStack
        {...host}
        actions={{
          ...host.actions,
          renderLinkedAgentPanel: (agent, parentSessionId, tc) => (
            <InlineAgentPanel
              agent={agent}
              parentSessionId={parentSessionId}
              defaultOpen={
                tc.status === 'running' || agent.status === 'running'
              }
            />
          ),
        }}
      />
    </div>
  );
};
