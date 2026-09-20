/**
 * MessageToolCallsSection.tsx
 * 24px 思考与工具单行虚拟滚动集成容器（DIM-03 / DIM-04 组合根）。
 *
 * 核心特性：
 * - 整合 24px 极简思考行（ReasoningRow）与 24px 工具单行（ChatToolStack）；
 * - 展开或收拢思考/工具时，联动 ResizeObserver 触发 VSM 树状数组动态测高自愈（invalidateActual + setActual）；
 * - 保持关联子 agent 行渲染器（InlineAgentPanel）懒加载注入。
 */
import React, { lazy, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import styles from './ChatMessageRow.module.css';
import { ChatToolStack, type ChatToolStackSharedProps } from '../chat-tool-call/ChatToolCallBlock';
import type { ToolRenderItem } from '../../api/toolPresentation';
import type { MessageToolCall, SessionAgent } from '../../store/types';
import { buildToolStackHostProps, shouldHostToolStack } from './chatMessageRowUtils';
import { ReasoningRow } from './ReasoningRow';
import type { VirtualScrollManager } from '../../api/VirtualScrollManager';
import { ResizeObserverManager } from '../ui/utils/ResizeObserverManager';

/**
 * 关联子 agent 行渲染器：内嵌 InlineAgentPanel（懒加载保持分包）。
 * 注入点选择：chat-tool-call 不得反向依赖 agent-card（InlineAgentPanel →
 * ChatToolStack → CompactToolRow 环形依赖），组合根在此提供渲染器。
 */
const InlineAgentPanel = lazy(() =>
  import('../agent-card/InlineAgentPanel').then((m) => ({ default: m.InlineAgentPanel }))
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

export type MessageToolSectionItem = ToolRenderItem | MessageToolSectionThoughtItem;

export interface MessageToolCallsSectionProps {
  items: MessageToolSectionItem[] | ToolRenderItem[] | undefined | null;
  msgId: string;
  toolStackProps: ChatToolStackSharedProps;
  /** 可选：24px 极简思考行配置（支持独立传入或在 items 中混合） */
  thinking?: MessageThinkingConfig | undefined;
  /** 可选：VSM 树状数组动态高度管理器，用于展开/折叠时测高自愈 */
  virtualScrollManager?: VirtualScrollManager | null | undefined;
}

export const MessageToolCallsSection: React.FC<MessageToolCallsSectionProps> =
  React.memo(function MessageToolCallsSection({
    items,
    msgId,
    toolStackProps,
    thinking,
    virtualScrollManager,
  }) {
    const sectionRef = useRef<HTMLDivElement>(null);

    // 1. 提取思考项（支持 thinking prop 优先，或从 items 中提取 kind: 'thought' 项）
    const thinkingItem = useMemo((): MessageThinkingConfig | null => {
      if (thinking && thinking.content && thinking.content.trim()) return thinking;
      if (Array.isArray(items)) {
        for (const it of items) {
          if (it && typeof it === 'object' && 'kind' in it && it.kind === 'thought') {
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

    // 3. 工具展开/折叠拦截：通知外部状态同时立即使 VSM 旧实测高度失效，触发自愈
    const handleToggleTool = useCallback(
      (toolId: string, currentlyOpen: boolean) => {
        toolStackProps.onToggleTool?.(toolId, currentlyOpen, msgId);
        virtualScrollManager?.invalidateActual(msgId);
      },
      [toolStackProps, virtualScrollManager, msgId]
    );

    // 4. 思考行展开/折叠回调：立即使 VSM 旧实测高度失效
    const handleToggleThinking = useCallback(() => {
      virtualScrollManager?.invalidateActual(msgId);
    }, [virtualScrollManager, msgId]);

    // 5. 监听 DOM 尺寸变化：联动 ResizeObserver 驱动 VSM 动态测高自愈
    useLayoutEffect(() => {
      const el = sectionRef.current;
      if (!el) return;
      const roManager = ResizeObserverManager.getInstance();
      const onResize = (entry: ResizeObserverEntry) => {
        if (entry.contentRect.height > 0) {
          virtualScrollManager?.invalidateActual(msgId);
        }
      };
      roManager.observe(el, onResize);
      return () => roManager.unobserve(el, onResize);
    }, [msgId, virtualScrollManager]);

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
            tc: MessageToolCall,
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
        ref={sectionRef}
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
            onToggle={handleToggleThinking}
          />
        ) : null}

        {hasTools && hostWithAgentPanel ? (
          <ChatToolStack {...hostWithAgentPanel} />
        ) : null}
      </div>
    );
  });

MessageToolCallsSection.displayName = 'MessageToolCallsSection';
