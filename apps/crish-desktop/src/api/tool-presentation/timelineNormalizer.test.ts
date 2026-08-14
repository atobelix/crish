import { describe, expect, it } from 'vitest';
import type { MessageToolCall, SessionMessage } from '../../store/layoutStore';
import {
  buildAssistantTimeline,
  buildToolRenderItems,
  dedupeToolCalls,
  normalizeAssistantTimeline,
  timelineSignature,
} from './timelineNormalizer';

function makeToolCall(
  partial: Partial<MessageToolCall> &
    Pick<MessageToolCall, 'id' | 'name' | 'status'>
): MessageToolCall {
  return {
    arguments: '',
    ...partial,
  };
}

function makeMessage(
  partial: Partial<SessionMessage> & Pick<SessionMessage, 'id' | 'sender'>
): SessionMessage {
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
        makeToolCall({
          id: 't1',
          name: 'bash',
          status: 'success',
          output: 'ok',
        }),
      ];
      const deduped = dedupeToolCalls(tools);
      expect(deduped.length).toBe(1);
      expect(deduped[0]?.status).toBe('success');
      expect(deduped[0]?.output).toBe('ok');
    });

    it('filters out interrupted tools', () => {
      const tools: MessageToolCall[] = [
        makeToolCall({
          id: 't1',
          name: 'bash',
          status: 'error',
          output: '会话中断',
        }),
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
        makeToolCall({
          id: 't1',
          name: 'read_file',
          status: 'success',
          output: 'file contents',
        }),
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
          makeToolCall({
            id: 't1',
            name: 'read_file',
            status: 'success',
            output: 'content',
          }),
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

  describe('timelineSignature 状态感知与单调性防线 (A-02)', () => {
    it('交错 blocks 消息在 processing 与 completed 状态下生成不同的签名', () => {
      const baseMsg: SessionMessage = {
        id: 'msg-interleaved',
        sender: 'assistant',
        status: 'processing',
        blocks: [
          { type: 'text', content: '前置分析：' },
          { type: 'tool_call', id: 't1' },
          { type: 'text', content: '最终结论：扫描完成。' },
        ],
        toolCalls: [
          makeToolCall({ id: 't1', name: 'search', status: 'success' }),
        ],
      };

      const sigProcessing = timelineSignature(baseMsg);
      const sigCompleted = timelineSignature({
        ...baseMsg,
        status: 'completed',
      });

      expect(sigProcessing).not.toBe(sigCompleted);
    });

    it('completed 状态下尾部 text 块内容变化必须导致签名改变', () => {
      const msgA: SessionMessage = {
        id: 'msg-interleaved',
        sender: 'assistant',
        status: 'completed',
        blocks: [
          { type: 'text', content: '前置分析：' },
          { type: 'tool_call', id: 't1' },
          { type: 'text', content: '阶段文本 A' },
        ],
        toolCalls: [
          makeToolCall({ id: 't1', name: 'search', status: 'success' }),
        ],
      };
      const msgB: SessionMessage = {
        ...msgA,
        blocks: [
          { type: 'text', content: '前置分析：' },
          { type: 'tool_call', id: 't1' },
          { type: 'text', content: '阶段文本 A + 追加的长文本 B' },
        ],
      };

      expect(timelineSignature(msgA)).not.toBe(timelineSignature(msgB));
    });

    it('无显式 text 块时，msg.text 在 completed 状态下纳入签名投影', () => {
      const msgA: SessionMessage = {
        id: 'msg-no-blocks',
        sender: 'assistant',
        status: 'completed',
        text: '第一版正文',
        blocks: [],
        toolCalls: [],
      };
      const msgB: SessionMessage = {
        ...msgA,
        text: '第二版修改正文',
      };

      expect(timelineSignature(msgA)).not.toBe(timelineSignature(msgB));
    });
  });
});
