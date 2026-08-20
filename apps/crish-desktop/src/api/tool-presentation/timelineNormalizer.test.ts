import { describe, expect, it } from 'vitest';
import type { MessageToolCall, SessionMessage } from '../../store/layoutStore';
import {
  alignToolCallBlocks,
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

    it('V1-γ 折叠单源：连续可折叠 inspect 组 label 复活为折叠头文案', () => {
      const tools: MessageToolCall[] = [
        makeToolCall({ id: 't1', name: 'list_dir', status: 'running' }),
        makeToolCall({ id: 't2', name: 'list_dir', status: 'running' }),
        makeToolCall({ id: 't3', name: 'list_dir', status: 'running' }),
      ];
      const items = buildToolRenderItems(tools);
      expect(items.length).toBe(1);
      expect(items[0]?.kind).toBe('group');
      if (items[0]?.kind === 'group') {
        expect(items[0].tools).toHaveLength(3);
        // 死字段 label 复活：渲染端折叠头文案 `${toolHumanLabel(last)} · ${n} 步`
        expect(items[0].label).toMatch(/· 3 步$/);
        expect(items[0].id).toBe('grp-t1');
      }
    });

    it('V1-γ 同轮并行（turnId 相同 + startedAt ≤200ms）也并入投影层 group', () => {
      const tools: MessageToolCall[] = [
        makeToolCall({
          id: 'p1',
          name: 'run_command',
          status: 'success',
          turnId: 'turn-1',
          startedAt: 1000,
        }),
        makeToolCall({
          id: 'p2',
          name: 'run_command',
          status: 'success',
          turnId: 'turn-1',
          startedAt: 1100,
        }),
      ];
      const items = buildToolRenderItems(tools);
      expect(items.length).toBe(1);
      expect(items[0]?.kind).toBe('group');
      if (items[0]?.kind === 'group') {
        expect(items[0].tools.map((t) => t.id)).toEqual(['p1', 'p2']);
        expect(items[0].label).toMatch(/· 2 步$/);
      }
    });

    it('V1-γ 跨轮同 turnId 但 startedAt 相距 >200ms 不并入（保持单条）', () => {
      const tools: MessageToolCall[] = [
        makeToolCall({
          id: 'p1',
          name: 'run_command',
          status: 'success',
          turnId: 'turn-1',
          startedAt: 1000,
        }),
        makeToolCall({
          id: 'p2',
          name: 'run_command',
          status: 'success',
          turnId: 'turn-1',
          startedAt: 2000,
        }),
      ];
      const items = buildToolRenderItems(tools);
      expect(items.every((i) => i.kind === 'single')).toBe(true);
    });

    it('V1-γ 可展示结果 inspect 中断折叠流（单条，不并入 running 组）', () => {
      const tools: MessageToolCall[] = [
        makeToolCall({
          id: 't1',
          name: 'list_dir',
          status: 'success',
          output: 'src\nnode_modules',
        }),
        makeToolCall({ id: 't2', name: 'list_dir', status: 'running' }),
        makeToolCall({ id: 't3', name: 'list_dir', status: 'running' }),
      ];
      const items = buildToolRenderItems(tools);
      expect(items[0]?.kind).toBe('single');
      expect(items[1]?.kind).toBe('group');
      if (items[1]?.kind === 'group') {
        expect(items[1].tools.map((t) => t.id)).toEqual(['t2', 't3']);
      }
    });
  });

  describe('alignToolCallBlocks（V1-δ 单一对齐源）', () => {
    it('注入缺失 tool_call 块：仅 text 时置前', () => {
      const blocks = [{ type: 'text' as const, content: '正文' }];
      const next = alignToolCallBlocks(blocks, [
        makeToolCall({ id: 't1', name: 'bash', status: 'success' }),
      ]);
      expect(next[0]).toEqual({ type: 'tool_call', id: 't1' });
      expect(next[1]).toEqual({ type: 'text', content: '正文' });
    });

    it('注入缺失 tool_call 块：插到最后 text 块之前', () => {
      const blocks = [
        { type: 'tool_call' as const, id: 't1' },
        { type: 'text' as const, content: '前半' },
        { type: 'text' as const, content: '结尾' },
      ];
      const next = alignToolCallBlocks(blocks, [
        makeToolCall({ id: 't1', name: 'bash', status: 'success' }),
        makeToolCall({ id: 't2', name: 'bash', status: 'success' }),
      ]);
      expect(next.map((b) => b.type)).toEqual([
        'tool_call',
        'text',
        'tool_call',
        'text',
      ]);
      expect(next[2]).toEqual({ type: 'tool_call', id: 't2' });
    });

    it('剔除悬空 tool_call 块（id 不在 tools 中）', () => {
      const blocks = [
        { type: 'tool_call' as const, id: 'ghost' },
        { type: 'tool_call' as const, id: 't1' },
        { type: 'text' as const, content: 'x' },
      ];
      const next = alignToolCallBlocks(blocks, [
        makeToolCall({ id: 't1', name: 'bash', status: 'success' }),
      ]);
      expect(next.map((b) => (b.type === 'tool_call' ? b.id : b.type))).toEqual(
        ['t1', 'text']
      );
    });

    it('无缺失时返回过滤后的块（不增不减有效块）', () => {
      const blocks = [{ type: 'tool_call' as const, id: 't1' }];
      const next = alignToolCallBlocks(blocks, [
        makeToolCall({ id: 't1', name: 'bash', status: 'success' }),
      ]);
      expect(next).toEqual([{ type: 'tool_call', id: 't1' }]);
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

    it('builds full interleaved timeline with thought, tool_call, and text in true order', () => {
      const msg = makeMessage({
        id: 'msg-multi-step',
        sender: 'assistant',
        toolCalls: [
          makeToolCall({
            id: 'tc-1',
            name: 'grep_search',
            status: 'success',
            output: 'match found',
          }),
          makeToolCall({
            id: 'tc-2',
            name: 'replace_file_content',
            status: 'success',
            output: 'replaced',
          }),
        ],
        blocks: [
          {
            type: 'thought',
            content: '第一步思考：需要检索定义',
            turnIndex: 0,
          },
          { type: 'tool_call', id: 'tc-1' },
          {
            type: 'thought',
            content: '第二步思考：修改文件内容',
            turnIndex: 1,
          },
          { type: 'tool_call', id: 'tc-2' },
          { type: 'text', content: '最终交付物：任务已圆满完成！' },
        ],
      });

      const timeline = buildAssistantTimeline(msg);
      expect(timeline.length).toBe(5);
      expect(timeline[0]?.kind).toBe('thought');
      expect((timeline[0] as { content: string }).content).toBe(
        '第一步思考：需要检索定义'
      );
      expect(timeline[1]?.kind).toBe('tools');
      expect(timeline[2]?.kind).toBe('thought');
      expect((timeline[2] as { content: string }).content).toBe(
        '第二步思考：修改文件内容'
      );
      expect(timeline[3]?.kind).toBe('tools');
      expect(timeline[4]?.kind).toBe('text');
      expect((timeline[4] as { content: string }).content).toBe(
        '最终交付物：任务已圆满完成！'
      );
    });

    it('supports fallback to thinkingTurns when blocks are not provided', () => {
      const msg = makeMessage({
        id: 'msg-turns',
        sender: 'assistant',
        text: 'Reply',
        thinkingTurns: [
          { turnIndex: 0, content: 'Turn 0 thought', durationMs: 1200 },
          { turnIndex: 1, content: 'Turn 1 thought', durationMs: 800 },
        ],
      });

      const timeline = buildAssistantTimeline(msg);
      expect(timeline.length).toBe(3);
      expect(timeline[0]?.kind).toBe('thought');
      expect(timeline[1]?.kind).toBe('thought');
      expect(timeline[2]?.kind).toBe('text');
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

    it('V1-γ R3：turnId/startedAt 变化必须击穿签名（并行折叠组结构不滞后）', () => {
      const base: SessionMessage = {
        id: 'msg-parallel-sig',
        sender: 'assistant',
        status: 'processing',
        toolCalls: [
          makeToolCall({
            id: 'p1',
            name: 'run_command',
            status: 'running',
            turnId: 'turn-1',
            startedAt: 1000,
          }),
        ],
      };
      // startedAt 到达（并行判组依赖字段）→ 签名必须变化
      const withStartedAt: SessionMessage = {
        ...base,
        toolCalls: [
          makeToolCall({
            id: 'p1',
            name: 'run_command',
            status: 'running',
            turnId: 'turn-1',
            startedAt: 1100,
          }),
        ],
      };
      expect(timelineSignature(base)).not.toBe(
        timelineSignature(withStartedAt)
      );
      // turnId 变化同理
      const otherTurn: SessionMessage = {
        ...withStartedAt,
        toolCalls: [
          makeToolCall({
            id: 'p1',
            name: 'run_command',
            status: 'running',
            turnId: 'turn-2',
            startedAt: 1100,
          }),
        ],
      };
      expect(timelineSignature(withStartedAt)).not.toBe(
        timelineSignature(otherTurn)
      );
    });

    it('extracts inline <think> and <thought> tags into structured thought timeline items', () => {
      const msg = makeMessage({
        id: 'msg-think',
        sender: 'assistant',
        text: '<think>我先了解一下当前工作区的情况，再开始创建项目。</think>已为你创建项目。',
      });
      const timeline = buildAssistantTimeline(msg);
      expect(timeline.length).toBe(2);
      expect(timeline[0]?.kind).toBe('thought');
      expect((timeline[0] as { content?: string })?.content).toBe(
        '我先了解一下当前工作区的情况，再开始创建项目。'
      );
      expect(timeline[1]?.kind).toBe('text');
      expect((timeline[1] as { content?: string })?.content).toBe(
        '已为你创建项目。'
      );
    });
  });
});
