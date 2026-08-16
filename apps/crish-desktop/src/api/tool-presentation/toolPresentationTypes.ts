/**
 * 工具展示与时间线类型与契约。
 */

import type { MessageToolCall } from '../../store/layoutStore';

export type ToolRenderItem =
  | { kind: 'single'; tc: MessageToolCall }
  | { kind: 'group'; id: string; tools: MessageToolCall[]; label: string };

export type ToolRowTone = 'running' | 'success' | 'error' | 'pending' | 'idle';

export type TimelineThoughtItem = {
  kind: 'thought';
  key: string;
  content: string;
  id?: string;
  turnIndex?: number;
  durationMs?: number;
  isLive?: boolean;
  isStreaming?: boolean;
  isHistoricalCollapsed?: boolean;
};

export type TimelineTextItem = {
  kind: 'text';
  content: string;
  key: string;
  turnIndex?: number;
  isFinal?: boolean;
};

export type TimelineToolsItem = {
  kind: 'tools';
  items: ToolRenderItem[];
  key: string;
  turnIndex?: number;
};

export type AssistantTimelineItem =
  TimelineThoughtItem | TimelineTextItem | TimelineToolsItem;
