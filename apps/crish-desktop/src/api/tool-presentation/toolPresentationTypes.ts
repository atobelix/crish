/**
 * 工具展示与时间线类型与契约。
 */

import type { MessageToolCall } from '../../store/layoutStore';

export type ToolRenderItem =
  | { kind: 'single'; tc: MessageToolCall }
  | { kind: 'group'; id: string; tools: MessageToolCall[]; label: string };

export type ToolRowTone = 'running' | 'success' | 'error' | 'pending' | 'idle';

export type TimelineTextItem = { kind: 'text'; content: string; key: string };

export type AssistantTimelineItem =
  | TimelineTextItem
  | { kind: 'tools'; items: ToolRenderItem[]; key: string };
