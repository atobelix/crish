/**
 * 助手行 tools / thought 可选注入槽。
 * 缺省空对象 = MessageContent 画扁平行（ChatToolCallBlock / TimelineThoughtSection）。
 * 叙事插件经 ChatMessageList 提供；不经过 Virtualizer memo 比较器。
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { ToolRenderItem } from '../../api/toolPresentation';
import type { ChatToolStackSharedProps } from '../chat-tool-call/ChatToolCallBlock';

export interface ChatNarrativeRenderToolsArgs {
  items: ToolRenderItem[];
  msgId: string;
  toolStackProps: ChatToolStackSharedProps;
}

export interface ChatNarrativeRenderThoughtArgs {
  content: string;
  isLive?: boolean;
  durationMs?: number;
  turnIndex?: number;
  startTime?: number;
  messageId?: string;
  /** 设置 hideThinkingBlock=false 时为 true（默认展开） */
  defaultOpen?: boolean;
}

export type ChatNarrativeRenderTools = (
  args: ChatNarrativeRenderToolsArgs
) => ReactNode;

export type ChatNarrativeRenderThought = (
  args: ChatNarrativeRenderThoughtArgs
) => ReactNode;

export interface NarrativeRenderSlots {
  renderTools?: ChatNarrativeRenderTools;
  renderThought?: ChatNarrativeRenderThought;
}

/** 关插件 / 未注入时的稳定空槽，避免 Provider value 每次新对象 */
export const EMPTY_NARRATIVE_SLOTS: NarrativeRenderSlots = {};

export const NarrativeRenderSlotsContext =
  createContext<NarrativeRenderSlots>(EMPTY_NARRATIVE_SLOTS);

export function useNarrativeRenderSlots(): NarrativeRenderSlots {
  return useContext(NarrativeRenderSlotsContext);
}
