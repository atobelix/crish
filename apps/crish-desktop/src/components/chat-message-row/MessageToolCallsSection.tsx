/**
 * MessageToolCallsSection.tsx
 * 24px 思考与工具单行虚拟滚动集成容器（DIM-03 / DIM-04 组合根）。
 *
 * 核心特性：
 * - 整合 24px 极简思考行（ReasoningRow）与 24px 工具单行（ChatToolStack）；
 * - 尺寸变化统一交由外层消息行宿主 ResizeObserver 单轨测量，组件内部零私有 RO 与零越权高度作废；
 * - 【R4b 分派提取】子 agent 分派调用在此从工具渲染项序列中**提取**为独立
 *   消息卡（SubagentDispatchCard，懒加载保持分包）：按发生顺序立在原位置，
 *   前后的普通工具各自成段进 FoldableToolGroup——分派不再被工具组吞没、
 *   不再以行替换形式藏在工具行里（CompactToolRow 的 renderLinkedAgentPanel
 *   注入路径已随提取整段删除）。提取判定与旧行替换同口径：findAgentForTool
 *   命中（parentToolCallId / 描述匹配）；未命中时分派调用降级为普通工具行。
 */
import React, { Suspense, lazy, useCallback, useMemo } from 'react';
import styles from './ChatMessageRow.module.css';
import type { ChatToolStackSharedProps } from '../chat-tool-call/ChatToolCallBlock';
import { FoldableToolGroup } from '../chat-tool-call/FoldableToolGroup';
import { findAgentForTool } from '../chat-tool-call/chatToolCallUtils';
import type { ToolRenderItem } from '../../api/toolPresentation';
import type { MessageToolCall, SessionAgent } from '../../store/types';
import {
  buildToolStackHostProps,
  shouldHostToolStack,
} from './chatMessageRowUtils';
import {
  ReasoningRow,
  extractLatestLine,
  stripInlineMarkdownMarkers,
} from './ReasoningRow';
import {
  LiveThoughtTickerProvider,
  type LiveThoughtTickerValue,
} from '../chat-message/liveThoughtTickerContext';
import { slotCore } from '../../services/view-registry/SlotCore';
import '../chat-card/workspaceChatComposerAbove.slot';

/**
 * 流内子 agent 分派卡（懒加载保持分包）。
 * 组合根在此直接渲染：chat-tool-call 不再需要反向注入渲染器。
 */
const SubagentDispatchCard = lazy(() =>
  import('../agent-card/SubagentDispatchCard').then((m) => ({
    default: m.SubagentDispatchCard,
  }))
);

/** 提取后的渲染块：普通工具段（进 FoldableToolGroup）或独立分派卡 */
type ToolSectionBlock =
  | { type: 'tools'; items: ToolRenderItem[] }
  | { type: 'dispatch'; agent: SessionAgent; tc: MessageToolCall };

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

    // 运行态思考承载（2026-11-06 第 9 条）：本节内混合的 live 思考与工具
    // 并存时，思考最新行经 context 交组头 ticker 统一呈现，本节思考行
    // 转静态标签（hosted），不留第二条动态通道。无内嵌思考时不提供
    // context，子树继承外层 FoldableProcessSection 的段级提供。
    const liveThoughtValue = useMemo<LiveThoughtTickerValue | null>(() => {
      if (!thinkingItem?.isLive || !hasTools) return null;
      const line =
        stripInlineMarkdownMarkers(extractLatestLine(thinkingItem.content)) ||
        null;
      return line ? { line, hosted: true, sectionLive: true } : null;
    }, [thinkingItem, hasTools]);

    // 3. 工具展开/折叠拦截：通知外部状态（尺寸变化由外层宿主 ResizeObserver 单轨自动测量）
    const handleToggleTool = useCallback(
      (toolId: string, currentlyOpen: boolean) => {
        toolStackProps.onToggleTool?.(toolId, currentlyOpen, msgId);
      },
      [toolStackProps, msgId]
    );

    // 4. 【R4b 提取】把渲染项序列切成「普通工具段 / 分派卡」块序列（保序）：
    //    single 且 findAgentForTool 命中 → 独立卡；其余（含未命中 agent 的
    //    分派调用、group 项）留在工具段。连续分派 = 连续卡块，不做汇总行。
    const blocks = useMemo((): ToolSectionBlock[] => {
      if (!hasTools) return [];
      const out: ToolSectionBlock[] = [];
      let run: ToolRenderItem[] = [];
      const flushRun = () => {
        if (run.length > 0) {
          out.push({ type: 'tools', items: run });
          run = [];
        }
      };
      for (const item of toolRenderItems) {
        if (item.kind === 'single') {
          const agent = findAgentForTool(item.tc, toolStackProps.agents);
          if (agent && toolStackProps.activeSessionId) {
            flushRun();
            out.push({ type: 'dispatch', agent, tc: item.tc });
            continue;
          }
        }
        run.push(item);
      }
      flushRun();
      return out;
    }, [
      hasTools,
      toolRenderItems,
      toolStackProps.agents,
      toolStackProps.activeSessionId,
    ]);

    // D7.4：每段 hostProps 引用稳定（useMemo），供 FoldableToolGroup / ChatToolStack memo 短路
    const blockHosts = useMemo(() => {
      return blocks.map((b) =>
        b.type === 'tools'
          ? buildToolStackHostProps(b.items, msgId, {
              ...toolStackProps,
              onToggleTool: handleToggleTool,
            })
          : null
      );
    }, [blocks, msgId, toolStackProps, handleToggleTool]);

    if (!hasTools && !hasThinking) return null;

    const sectionBody = (
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

        {blocks.map((block, i) => {
          if (block.type === 'dispatch') {
            return (
              <Suspense
                key={`dispatch-${block.tc.id}`}
                fallback={
                  <div
                    style={{ minHeight: 24 }}
                    data-dispatch-card-fallback={block.agent.id}
                    aria-hidden
                  />
                }
              >
                <SubagentDispatchCard
                  agent={block.agent}
                  parentSessionId={toolStackProps.activeSessionId}
                  parentToolCallId={block.tc.id}
                />
              </Suspense>
            );
          }
          const host = blockHosts[i];
          if (!host) return null;

          // 审批上提空组保护（R5 §6）：
          // 当 composerAbove 开启且组内工具全处于 pending_approval 时，
          // CompactToolRow 返回 null。渲染兜底提示文案，防止 0px 空白幽灵框。
          const isComposerAbove = Boolean(
            slotCore.getSingle('workspace.chat.composerAbove')
          );
          const allPendingApproval =
            isComposerAbove &&
            block.items.length > 0 &&
            block.items.every((it) => {
              const tools = it.kind === 'single' ? [it.tc] : it.tools;
              return (
                tools.length > 0 &&
                tools.every((t) => t.status === 'pending_approval')
              );
            });

          const firstItem = block.items[0];
          const groupId =
            firstItem?.kind === 'group'
              ? firstItem.groupId ||
                (firstItem.id?.startsWith('grp-')
                  ? firstItem.id.slice(4)
                  : firstItem.id)
              : firstItem?.kind === 'single'
                ? firstItem.tc.groupId
                : undefined;

          const groupTitle =
            firstItem?.kind === 'group'
              ? firstItem.groupTitle || firstItem.label
              : firstItem?.kind === 'single'
                ? firstItem.tc.group || firstItem.tc.intent
                : undefined;

          const isSealed =
            firstItem?.kind === 'group' ? firstItem.isSealed : undefined;

          // 基于组内首个工具的 tool ID 锚定持久 key，生命周期内永远不变，杜绝 groupId 注入时 key 漂移与 Remount 瞬闪
          const firstToolId =
            firstItem?.kind === 'group'
              ? firstItem.tools[0]?.id
              : firstItem?.kind === 'single'
                ? firstItem.tc.id
                : undefined;
          const itemKey = `g-${firstToolId || groupId || i}`;

          if (allPendingApproval) {
            const isGroup = firstItem?.kind === 'group';
            if (!isGroup) {
              return (
                <div
                  key={`pending-composer-${firstItem?.tc.id ?? i}`}
                  style={{
                    height: 24,
                    lineHeight: '24px',
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                    display: 'flex',
                    alignItems: 'center',
                    paddingLeft: 24,
                  }}
                  data-testid="composer-above-pending-notice"
                >
                  等待在输入框上方确认…
                </div>
              );
            }
            return (
              <div key={`pending-${itemKey}`}>
                <FoldableToolGroup
                  items={block.items}
                  msgId={msgId}
                  hostProps={host}
                  groupId={groupId}
                  groupTitle={groupTitle}
                  isSealed={isSealed}
                />
                <div
                  style={{
                    height: 24,
                    lineHeight: '24px',
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                    display: 'flex',
                    alignItems: 'center',
                    paddingLeft: 24,
                  }}
                  data-testid="composer-above-pending-notice"
                >
                  等待在输入框上方确认…
                </div>
              </div>
            );
          }

          return (
            <FoldableToolGroup
              key={itemKey}
              items={block.items}
              msgId={msgId}
              hostProps={host}
              groupId={groupId}
              groupTitle={groupTitle}
              isSealed={isSealed}
            />
          );
        })}
      </div>
    );

    if (liveThoughtValue) {
      return (
        <LiveThoughtTickerProvider value={liveThoughtValue}>
          {sectionBody}
        </LiveThoughtTickerProvider>
      );
    }
    return sectionBody;
  });

MessageToolCallsSection.displayName = 'MessageToolCallsSection';
