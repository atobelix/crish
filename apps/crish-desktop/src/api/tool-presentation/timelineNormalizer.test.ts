import { describe, expect, it } from 'vitest';
import type { MessageToolCall, SessionMessage } from '../../store/layoutStore';
import {
  buildAssistantTimeline,
  buildToolRenderItems,
  dedupeToolCalls,
  normalizeAssistantTimeline,
} from './timelineNormalizer';

function makeToolCall(partial: Partial<MessageToolCall> & Pick<MessageToolCall, 'id' | 'name' | 'status'>): MessageToolCall {
  return {
    arguments: '',
    ...partial,
  };
}

function makeMessage(partial: Partial<SessionMessage> & Pick<SessionMessage, 'id' | 'sender'>): SessionMessage {
  return {
    timestamp: Date.now(),
    ...partial,
  };
}

describe('timelineNormalizer', () => {
  describe('normalizeAssistantTimeline', () => {
    it('aligns blocks with toolCalls for assistant message', () => {
      const msg = makeMessage({
        id: 'msg-1',
        sender: 'assistant',
        text: 'Done processing',
        toolCalls: [
          makeToolCall({ id: 't1', name: 'read_file', status: 'success' }),
        ],
        blocks: [],
      });
      const normalized = normalizeAssistantTimeline(msg);
      expect(normalized.blocks?.length).toBe(2);
      expect(normalized.blocks?.[0]?.type).toBe('tool_call');
      expect(normalized.blocks?.[1]?.type).toBe('text');
    });

    it('leaves non-assistant messages unchanged', () => {
      const msg = makeMessage({
        id: 'msg-2',
        sender: 'user',
        text: 'Hello',
      });
      expect(normalizeAssistantTimeline(msg)).toBe(msg);
    });
  });

  describe('dedupeToolCalls', () => {
    it('deduplicates tool calls by id and preserves highest status rank', () => {
      const tools: MessageToolCall[] = [
        makeToolCall({ id: 't1', name: 'bash', status: 'running' }),
        makeToolCall({ id: 't1', name: 'bash', status: 'success', output: 'ok' }),
      ];
      const deduped = dedupeToolCalls(tools);
      expect(deduped.length).toBe(1);
      expect(deduped[0]?.status).toBe('success');
      expect(deduped[0]?.output).toBe('ok');
    });

    it('filters out interrupted tools', () => {
      const tools: MessageToolCall[] = [
        makeToolCall({ id: 't1', name: 'bash', status: 'error', output: '会话中断' }),
      ];
      expect(dedupeToolCalls(tools)).toEqual([]);
    });
  });

  describe('buildToolRenderItems', () => {
    it('groups consecutive non-inspecting or running inspect tools', () => {
      const tools: MessageToolCall[] = [
        makeToolCall({ id: 't1', name: 'list_dir', status: 'running' }),
        makeToolCall({ id: 't2', name: 'list_dir', status: 'running' }),
      ];
      const items = buildToolRenderItems(tools);
      expect(items.length).toBe(1);
      expect(items[0]?.kind).toBe('group');
    });

    it('returns single items for tools with displayable results', () => {
      const tools: MessageToolCall[] = [
        makeToolCall({ id: 't1', name: 'read_file', status: 'success', output: 'file contents' }),
      ];
      const items = buildToolRenderItems(tools);
      expect(items.length).toBe(1);
      expect(items[0]?.kind).toBe('single');
    });
  });

  describe('buildAssistantTimeline', () => {
    it('builds interleaved timeline items for text and tools', () => {
      const msg = makeMessage({
        id: 'msg-1',
        sender: 'assistant',
        text: 'Summary',
        toolCalls: [
          makeToolCall({ id: 't1', name: 'read_file', status: 'success', output: 'content' }),
        ],
        blocks: [
          { type: 'tool_call', id: 't1' },
          { type: 'text', content: 'Summary' },
        ],
      });
      const timeline = buildAssistantTimeline(msg);
      expect(timeline.length).toBe(2);
      expect(timeline[0]?.kind).toBe('tools');
      expect(timeline[1]?.kind).toBe('text');
    });
  });
});
