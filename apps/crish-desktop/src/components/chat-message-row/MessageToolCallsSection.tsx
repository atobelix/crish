/**
 * MessageToolCallsSection.tsx
 * 24px 思考与工具单行虚拟滚动集成容器（DIM-03 / DIM-04 组合根）。
 *
 * 核心特性：
 * - 整合 24px 极简思考行（ReasoningRow）与 24px 工具单行（ChatToolStack）；
 * - 尺寸变化统一交由外层消息行宿主 ResizeObserver 单轨测量，组件内部零私有 RO 与零越权高度作废；
 * - 保持关联子 agent 行渲染器（InlineAgentPanel）懒加载注入。
 */
import React, { lazy, useCallback, useMemo } from 'react';
import styles from './ChatMessageRow.module.css';
import type { ChatToolStackSharedProps } from '../chat-tool-call/ChatToolCallBlock';
import { FoldableToolGroup } from '../chat-tool-call/FoldableToolGroup';
import type { ToolRenderItem } from '../../api/toolPresentation';
import type { MessageToolCall, SessionAgent } from '../../store/types';
import {
  buildToolStackHostProps,
  shouldHostToolStack,
} from './chatMessageRowUtils';
import { ReasoningRow } from './ReasoningRow';

/**
 * 关联子 agent 行渲染器：内嵌 InlineAgentPanel（懒加载保持分包）。
 * 注入点选择：chat-tool-call 不得反向依赖 agent-card（InlineAgentPanel →
 * ChatToolStack → CompactToolRow 环形依赖），组合根在此提供渲染器。
 */
const InlineAgentPanel = lazy(() =>
  import('../agent-card/InlineAgentPanel').then((m) => ({
    default: m.InlineAgentPanel,
  }))
);

export interface MessageThinkingConfig {
  content: string;
  isLive?: boolean;
  durationMs?: number;
  turnIndex?: number;
  defaultExpanded?: boolean;
}

export type MessageToolSectionThoughtItem = {
  kind: 'thought';
  content: string;
  isLive?: boolean;
  durationMs?: number;
  turnIndex?: number;
  defaultExpanded?: boolean;
};

export type MessageToolSectionItem =
  ToolRenderItem | MessageToolSectionThoughtItem;

export interface MessageToolCallsSectionProps {
  items: MessageToolSectionItem[] | ToolRenderItem[] | undefined | null;
  msgId: string;
  toolStackProps: ChatToolStackSharedProps;
  /** 可选：24px 极简思考行配置（支持独立传入或在 items 中混合） */
  thinking?: MessageThinkingConfig | undefined;
}

export const MessageToolCallsSection: React.FC<MessageToolCallsSectionProps> =
  React.memo(function MessageToolCallsSection({
    items,
    msgId,
    toolStackProps,
    thinking,
  }) {
    // 1. 提取思考项（支持 thinking prop 优先，或从 items 中提取 kind: 'thought' 项）
    const thinkingItem = useMemo((): MessageThinkingConfig | null => {
      if (thinking && thinking.content && thinking.content.trim())
        return thinking;
      if (Array.isArray(items)) {
        for (const it of items) {
          if (
            it &&
            typeof it === 'object' &&
            'kind' in it &&
            it.kind === 'thought'
          ) {
            const thought = it as MessageToolSectionThoughtItem;
            if (thought.content && thought.content.trim()) {
              return {
                content: thought.content,
                isLive: thought.isLive,
                durationMs: thought.durationMs,
                turnIndex: thought.turnIndex,
                defaultExpanded: thought.defaultExpanded,
              };
            }
          }
        }
      }
      return null;
    }, [thinking, items]);

    // 2. 提取工具项
    const toolRenderItems = useMemo((): ToolRenderItem[] => {
      if (!Array.isArray(items)) return [];
      const list: ToolRenderItem[] = [];
      for (const it of items) {
        if (it && (it.kind === 'single' || it.kind === 'group')) {
          list.push(it);
        }
      }
      return list;
    }, [items]);

    const hasTools = shouldHostToolStack(toolRenderItems);
    const hasThinking = Boolean(thinkingItem && thinkingItem.content.trim());

    // 3. 工具展开/折叠拦截：通知外部状态（尺寸变化由外层宿主 ResizeObserver 单轨自动测量）
    const handleToggleTool = useCallback(
      (toolId: string, currentlyOpen: boolean) => {
        toolStackProps.onToggleTool?.(toolId, currentlyOpen, msgId);
      },
      [toolStackProps, msgId]
    );

    // D7.4：hostProps / actions 引用稳定（useMemo），供 FoldableToolGroup / ChatToolStack memo 短路
    const host = useMemo(() => {
      if (!hasTools) return null;
      return buildToolStackHostProps(toolRenderItems, msgId, {
        ...toolStackProps,
        onToggleTool: handleToggleTool,
      });
    }, [hasTools, toolRenderItems, msgId, toolStackProps, handleToggleTool]);

    const hostWithAgentPanel = useMemo(() => {
      if (!host) return null;
      return {
        ...host,
        actions: {
          ...host.actions,
          renderLinkedAgentPanel: (
            agent: SessionAgent,
            parentSessionId: string,
            tc: MessageToolCall
          ) => (
            <InlineAgentPanel
              agent={agent}
              parentSessionId={parentSessionId}
              defaultOpen={
                tc.status === 'running' || agent.status === 'running'
              }
            />
          ),
        },
      };
    }, [host]);

    if (!hasTools && !hasThinking) return null;

    return (
      <div
        className={styles.timelineTools}
        data-section="tool-calls"
        data-msg-id={msgId}
        data-testid="message-tool-calls-section"
      >
        {hasThinking && thinkingItem ? (
          <ReasoningRow
            content={thinkingItem.content}
            isLive={thinkingItem.isLive}
            durationMs={thinkingItem.durationMs}
            turnIndex={thinkingItem.turnIndex}
            defaultExpanded={thinkingItem.defaultExpanded}
            messageId={msgId}
          />
        ) : null}

        {hasTools && hostWithAgentPanel ? (
          <FoldableToolGroup
            items={toolRenderItems}
            msgId={msgId}
            hostProps={hostWithAgentPanel}
          />
        ) : null}
      </div>
    );
  });

MessageToolCallsSection.displayName = 'MessageToolCallsSection';
