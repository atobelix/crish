import { describe, expect, it } from 'vitest';
import type {
  MessageContextInjection,
  MessageToolCall,
  SessionMessage,
} from '../../store/layoutStore';
import {
  alignToolCallBlocks,
  buildAssistantTimeline,
  buildToolRenderItems,
  dedupeToolCalls,
  normalizeAssistantTimeline,
  parseInlineThoughtAndTextSafely,
  reconcileAssistantMessageBlocks,
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

function makeInjection(
  partial: Partial<MessageContextInjection>
): MessageContextInjection {
  return {
    id: 'inj-1',
    kind: 'rule',
    title: '项目规则: AGENTS.md',
    summary: '2 条规则',
    status: 'injected',
    source: 'rule_loader',
    content: '1. 必须使用 UTF-8 无 BOM\n2. 严禁 --no-verify',
    tokenEstimate: 120,
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

    /**
     * 【契约变更 · 断层 3 根治】旧实现一律插到「最后一个 text 块之前」，
     * 于是「正文 1 → 工具 2 → 正文 2」场景下缺失的工具 1 会被插到正文 2 之前
     * （即工具 2 之后），时序彻底倒流。现按因果时间戳就近插位，
     * 无时间戳时兜底插到**首个正文块之前**。
     */
    it('注入缺失 tool_call 块：无时间戳则插到首个 text 块之前（严禁盲目置到尾部正文前）', () => {
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
        'tool_call',
        'text',
        'text',
      ]);
      expect(next[1]).toEqual({ type: 'tool_call', id: 't2' });
    });

    it('断层 3 根治：正文 1 → 工具 2 → 正文 2 场景下缺失工具 1 必须插到正文 1 之前', () => {
      const blocks = [
        { type: 'text' as const, content: '正文 1' },
        { type: 'tool_call' as const, id: 't2' },
        { type: 'text' as const, content: '正文 2' },
      ];
      const next = alignToolCallBlocks(blocks, [
        makeToolCall({ id: 't1', name: 'bash', status: 'success' }),
        makeToolCall({ id: 't2', name: 'bash', status: 'success' }),
      ]);
      // 负向断言：t1 绝不能被插到「正文 2」之前（即 t2 之后）
      expect(next.map((b) => (b.type === 'tool_call' ? b.id : b.type))).toEqual([
        't1',
        'text',
        't2',
        'text',
      ]);
    });

    it('因果时间戳就近插位：工具按其 startedAt 插回真实发生时段', () => {
      const T0 = 1_700_000_000_000;
      const blocks = [
        { type: 'text' as const, content: '早', startTime: T0 + 0 },
        { type: 'tool_call' as const, id: 't-late', startTime: T0 + 5_000 },
      ];
      const next = alignToolCallBlocks(blocks, [
        makeToolCall({ id: 't-late', name: 'bash', status: 'success', startedAt: T0 + 5_000 }),
        makeToolCall({ id: 't-mid', name: 'bash', status: 'success', startedAt: T0 + 2_000 }),
      ]);
      // t-mid 的时间戳晚于「早」、早于 t-late，必须落在两者之间
      expect(next.map((b) => (b.type === 'tool_call' ? b.id : b.type))).toEqual([
        'text',
        't-mid',
        't-late',
      ]);
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

  describe('reconcileAssistantMessageBlocks (三元保全算法)', () => {
    it('T-01: 多轮交互中 100% 保留已有未被覆盖的历史 thought 与 tool_call 块', () => {
      const existingBlocks = [
        { type: 'thought' as const, content: 'Turn 0 思维链', turnIndex: 0 },
        { type: 'tool_call' as const, id: 'tool-0', turnIndex: 0 },
      ];
      const incomingBlocks = [
        { type: 'thought' as const, content: 'Turn 1 新思维链', turnIndex: 1 },
        { type: 'tool_call' as const, id: 'tool-1', turnIndex: 1 },
        { type: 'text' as const, content: '当前进行中', turnIndex: 1 },
      ];

      const blocks = reconcileAssistantMessageBlocks(existingBlocks, incomingBlocks);

      // 断言必须包含 2 个 thought 块、2 个 tool_call 块和 1 个 text 块
      expect(blocks.filter((b) => b.type === 'thought')).toHaveLength(2);
      expect(blocks.filter((b) => b.type === 'tool_call')).toHaveLength(2);
      expect(blocks.filter((b) => b.type === 'text')).toHaveLength(1);

      // 插入顺序（严格按流式到达顺序）：incoming turn1 块先出现，orphan turn0 块追加到末尾
      expect(blocks[0]).toMatchObject({ type: 'thought', content: 'Turn 1 新思维链', turnIndex: 1 });
      expect(blocks[1]).toMatchObject({ type: 'tool_call', id: 'tool-1' });
      expect(blocks[2]).toMatchObject({ type: 'text', content: '当前进行中', turnIndex: 1 });
      expect(blocks[3]).toMatchObject({ type: 'thought', content: 'Turn 0 思维链', turnIndex: 0 });
      expect(blocks[4]).toMatchObject({ type: 'tool_call', id: 'tool-0' });
    });

    it('以 (turnIndex, type, id) 为三元槽位更新内容，不产生重复块', () => {
      const existingBlocks = [
        {
          type: 'thought' as const,
          content: '旧思考内容',
          turnIndex: 0,
          id: 'th-0',
          durationMs: 100,
        },
        { type: 'tool_call' as const, id: 'tool-0', turnIndex: 0 },
      ];
      const incomingBlocks = [
        {
          type: 'thought' as const,
          content: '更新后的思考内容',
          turnIndex: 0,
          id: 'th-0',
          durationMs: 500,
        },
      ];

      const blocks = reconcileAssistantMessageBlocks(existingBlocks, incomingBlocks);
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toMatchObject({
        type: 'thought',
        content: '更新后的思考内容',
        turnIndex: 0,
        id: 'th-0',
        durationMs: 500,
      });
      expect(blocks[1]).toMatchObject({
        type: 'tool_call',
        id: 'tool-0',
      });
    });

    it('5 轮复杂 Agent 交互后最终包含全部 5 轮的 ThoughtBlock 与 ToolCallCard', () => {
      let blocks = [
        { type: 'thought' as const, content: 'T0 思考', turnIndex: 0 },
        { type: 'tool_call' as const, id: 't0', turnIndex: 0 },
      ];

      for (let turn = 1; turn < 5; turn++) {
        const nextTurnBlocks = [
          { type: 'thought' as const, content: `T${turn} 思考`, turnIndex: turn },
          { type: 'tool_call' as const, id: `t${turn}`, turnIndex: turn },
        ];
        blocks = reconcileAssistantMessageBlocks(blocks, nextTurnBlocks);
      }

      blocks = reconcileAssistantMessageBlocks(blocks, [
        { type: 'text' as const, content: '全部 5 轮完成', turnIndex: 4 },
      ]);

      expect(blocks.filter((b) => b.type === 'thought')).toHaveLength(5);
      expect(blocks.filter((b) => b.type === 'tool_call')).toHaveLength(5);
      expect(blocks.filter((b) => b.type === 'text')).toHaveLength(1);
      // 插入顺序：text 块是最后一轮 incoming，但 orphan 追加后它不在末尾——改为按内容查找
      const textBlock = blocks.find((b) => b.type === 'text');
      expect(textBlock?.content).toBe('全部 5 轮完成');
    });

    it('NaN、负数及浮点数 turnIndex 边界清洗后，结果按插入顺序（到达顺序）输出', () => {
      const existing = [
        { type: 'thought' as const, content: '历史思考', turnIndex: -2 },
        { type: 'tool_call' as const, id: 't-legacy', turnIndex: NaN },
      ];
      // 传入乱序且带浮点数 turnIndex 的 incoming blocks
      const incoming = [
        { type: 'text' as const, content: '正文 T0', turnIndex: 0 },
        { type: 'text' as const, content: '正文 T1', turnIndex: 1.7 },
        { type: 'tool_call' as const, id: 't-1', turnIndex: 1.2 },
        { type: 'thought' as const, content: '思考 T1', turnIndex: 1 },
      ];

      const reconciled = reconcileAssistantMessageBlocks(existing, incoming);

      // 插入顺序：incoming 4块先出现（按原始顺序），然后是 orphan 的 existing 2块（thought、tool_call）
      // 注意：existing 中 turnIndex=-2 → cleanTurn=0，NaN → cleanTurn=0
      // 但 incoming 中的 '0:text:' 与 existing 中 '0:thought:' 和 '0:tool_call:t-legacy' 槽位不同，所以 existing 全是 orphan
      expect(reconciled).toHaveLength(6);
      // incoming 顺序输出
      expect(reconciled[0]).toMatchObject({ content: '正文 T0', turnIndex: 0 });
      expect(reconciled[1]).toMatchObject({ content: '正文 T1', turnIndex: 1 });
      expect(reconciled[2]).toMatchObject({ id: 't-1', turnIndex: 1 });
      expect(reconciled[3]).toMatchObject({ content: '思考 T1', turnIndex: 1 });
      // orphan existing 追加到末尾
      expect(reconciled[4]).toMatchObject({ content: '历史思考', turnIndex: 0 });
      expect(reconciled[5]).toMatchObject({ id: 't-legacy', turnIndex: 0 });
    });

    it('当 incomingBlocks 仅包含最新轮次纯文本时，历史所有 orphan 思考块与工具块 100% 永久保全', () => {
      const existing = [
        { type: 'thought' as const, content: '第 0 轮思考', turnIndex: 0 },
        { type: 'tool_call' as const, id: 'tool-0', turnIndex: 0 },
        { type: 'thought' as const, content: '第 1 轮思考', turnIndex: 1 },
        { type: 'tool_call' as const, id: 'tool-1', turnIndex: 1 },
      ];
      const incoming = [
        { type: 'text' as const, content: '最终交付汇总', turnIndex: 2 },
      ];

      const reconciled = reconcileAssistantMessageBlocks(existing, incoming);

      expect(reconciled).toHaveLength(5);
      // 插入顺序：incoming 的 turn2 text 先出现，然后 orphan 按 existingMap 迭代顺序追加
      expect(reconciled[0]).toMatchObject({ type: 'text', content: '最终交付汇总', turnIndex: 2 });
      expect(reconciled[1]).toMatchObject({ type: 'thought', content: '第 0 轮思考', turnIndex: 0 });
      expect(reconciled[2]).toMatchObject({ type: 'tool_call', id: 'tool-0', turnIndex: 0 });
      expect(reconciled[3]).toMatchObject({ type: 'thought', content: '第 1 轮思考', turnIndex: 1 });
      expect(reconciled[4]).toMatchObject({ type: 'tool_call', id: 'tool-1', turnIndex: 1 });
    });
  });

  describe('parseInlineThoughtAndTextSafely (Markdown 代码块免疫与流式防御)', () => {
    it('T-02: 处于 Markdown 多行代码栅栏 ``` 内的 <think> 标签严禁被提取为思考项', () => {
      const markdownCode = '演示代码：\n```xml\n<think>不要提取我</think>\n```\n结束。';
      const items = parseInlineThoughtAndTextSafely(markdownCode, 0, false);

      expect(items.some((i) => i.kind === 'thought')).toBe(false);
      expect(items).toHaveLength(1);
      expect(items[0]!.kind).toBe('text');
      expect(items[0]!.content).toBe(markdownCode);
    });

    it('处于 Markdown 多行代码栅栏 ~~~ 内的 <think> 标签严禁被提取', () => {
      const markdownCode = '~~~markdown\n<think>代码示例</think>\n~~~';
      const items = parseInlineThoughtAndTextSafely(markdownCode, 0, false);

      expect(items.some((i) => i.kind === 'thought')).toBe(false);
      expect(items).toHaveLength(1);
      expect(items[0]!.content).toBe(markdownCode);
    });

    it('处于 Markdown 行内代码 ` ` 内的 <think> 标签严禁被提取', () => {
      const inlineCode = '这是行内代码 `<think>测试标签</think>` 说明。';
      const items = parseInlineThoughtAndTextSafely(inlineCode, 0, false);

      expect(items.some((i) => i.kind === 'thought')).toBe(false);
      expect(items).toHaveLength(1);
      expect(items[0]!.content).toBe(inlineCode);
    });

    it('T-03: 流式未闭合的 <think> 标签必须安全切分为 isStreaming 思考块', () => {
      const streamingRaw = '前置说明：\n<think>正在思考系统架构设计方案';
      const items = parseInlineThoughtAndTextSafely(streamingRaw, 0, true);

      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({ kind: 'text', content: '前置说明：\n' });
      expect(items[1]).toMatchObject({
        kind: 'thought',
        content: '正在思考系统架构设计方案',
        isStreaming: true,
      });
    });

    it('流式代码块内的未闭合 <think> 保持为代码文本，不误判为流式思考块', () => {
      const streamingCode = '```xml\n<think>正在写代码示例';
      const items = parseInlineThoughtAndTextSafely(streamingCode, 0, true);

      expect(items.some((i) => i.kind === 'thought')).toBe(false);
      expect(items[0]!.kind).toBe('text');
      expect(items[0]!.content).toBe(streamingCode);
    });

    it('混合场景：既有正常代码块又有真实思考标签时精准分拣', () => {
      const mixed = '<think>真实思考1</think>正文说明：\n```xml\n<think>假思考</think>\n```\n<think>真实思考2</think>最终正文。';
      const items = parseInlineThoughtAndTextSafely(mixed, 0, false);

      expect(items).toHaveLength(4);
      expect(items[0]).toMatchObject({ kind: 'thought', content: '真实思考1' });
      expect(items[1]).toMatchObject({
        kind: 'text',
        content: '正文说明：\n```xml\n<think>假思考</think>\n```\n',
      });
      expect(items[2]).toMatchObject({ kind: 'thought', content: '真实思考2' });
      expect(items[3]).toMatchObject({ kind: 'text', content: '最终正文。' });
    });
  });

  describe('buildAssistantTimeline 注入卡片分支（context_injection）', () => {
    const inj = makeInjection({ id: 'inj-rule-1' });

    it('按 blocks 声明的 context_injection 块排布注入项（flushTools 语义保持）', () => {
      const msg = makeMessage({
        id: 'msg-inj-order',
        sender: 'assistant',
        toolCalls: [
          makeToolCall({
            id: 't1',
            name: 'grep_search',
            status: 'success',
            output: 'match',
          }),
        ],
        injections: [inj],
        blocks: [
          { type: 'context_injection', id: 'inj-rule-1' },
          { type: 'tool_call', id: 't1' },
          { type: 'text', content: '基于上述规则完成检索' },
        ],
      });

      const timeline = buildAssistantTimeline(msg);
      expect(timeline[0]).toMatchObject({
        kind: 'injection',
        key: 'injection-inj-rule-1',
      });
      expect(timeline[1]?.kind).toBe('tools');
      expect(timeline[2]?.kind).toBe('text');
    });

    it('blocks 缺 injections 时回退 b.injection 内联载荷', () => {
      const inlineInj = makeInjection({ id: 'inj-inline-1' });
      const msg = makeMessage({
        id: 'msg-inj-inline',
        sender: 'assistant',
        text: '规则已就位',
        blocks: [
          {
            type: 'context_injection',
            id: 'inj-inline-1',
            injection: inlineInj,
          },
          { type: 'text', content: '规则已就位' },
        ],
      });

      const timeline = buildAssistantTimeline(msg);
      expect(timeline[0]?.kind).toBe('injection');
      if (timeline[0]?.kind === 'injection') {
        expect(timeline[0].injection).toEqual(inlineInj);
      }
    });

    it('孤儿注入兜底：injections 存在但 blocks 未声明时置顶挂载', () => {
      const orphan = makeInjection({ id: 'inj-orphan-1' });
      const msg = makeMessage({
        id: 'msg-inj-orphan',
        sender: 'assistant',
        text: '正文开始',
        injections: [orphan],
        blocks: [{ type: 'text', content: '正文开始' }],
      });

      const timeline = buildAssistantTimeline(msg);
      expect(timeline[0]?.kind).toBe('injection');
      if (timeline[0]?.kind === 'injection') {
        expect(timeline[0].key).toBe('injection-orphan-inj-orphan-1');
        expect(timeline[0].injection.id).toBe('inj-orphan-1');
      }
      expect(timeline[1]?.kind).toBe('text');
    });

    it('历史无 blocks 消息降级：injections 置顶列出后接 text', () => {
      const legacy = makeInjection({ id: 'inj-legacy-1' });
      const msg = makeMessage({
        id: 'msg-inj-legacy',
        sender: 'assistant',
        text: '历史正文',
        injections: [legacy],
      });

      const timeline = buildAssistantTimeline(msg);
      expect(timeline[0]?.kind).toBe('injection');
      if (timeline[0]?.kind === 'injection') {
        expect(timeline[0].injection.id).toBe('inj-legacy-1');
      }
      expect(timeline[1]?.kind).toBe('text');
    });

    it('孤儿工具兜底在注入置顶后仍正常追加（不互斥）', () => {
      const orphan = makeInjection({ id: 'inj-orphan-2' });
      const msg = makeMessage({
        id: 'msg-inj-orphan-tool',
        sender: 'assistant',
        text: '收尾',
        toolCalls: [
          makeToolCall({
            id: 't-orphan',
            name: 'read_file',
            status: 'success',
            output: 'data',
          }),
        ],
        injections: [orphan],
        blocks: [{ type: 'text', content: '收尾' }],
      });

      const timeline = buildAssistantTimeline(msg);
      expect(timeline[0]?.kind).toBe('injection');
      expect(timeline[1]?.kind).toBe('text');
      expect(timeline[2]?.kind).toBe('tools');
    });
  });

  describe('timelineSignature 注入投影（id:status:tokenEstimate）', () => {
    const baseInj = makeInjection({ id: 'inj-sig-1' });

    it('注入 status 跃迁（pending → injected）必须击穿签名', () => {
      const msgA: SessionMessage = {
        id: 'msg-inj-sig',
        sender: 'assistant',
        text: '正文',
        injections: [{ ...baseInj, status: 'pending' }],
        blocks: [
          { type: 'context_injection', id: 'inj-sig-1' },
          { type: 'text', content: '正文' },
        ],
      };
      const sigPending = timelineSignature(msgA);
      const sigInjected = timelineSignature({
        ...msgA,
        injections: [{ ...baseInj, status: 'injected' }],
      });
      expect(sigPending).not.toBe(sigInjected);
    });

    it('注入 tokenEstimate 变化必须击穿签名；纯文本流式帧不改变注入签名', () => {
      const msgA: SessionMessage = {
        id: 'msg-inj-sig-te',
        sender: 'assistant',
        status: 'completed',
        text: '正文',
        injections: [{ ...baseInj, tokenEstimate: 100 }],
        blocks: [{ type: 'text', content: '正文' }],
      };
      const sigA = timelineSignature(msgA);
      const sigB = timelineSignature({
        ...msgA,
        injections: [{ ...baseInj, tokenEstimate: 500 }],
      });
      expect(sigA).not.toBe(sigB);
      // 纯正文变化（非流式 completed）→ 注入签名不参与文本键 → 签名整体仍变化
      const sigTextChanged = timelineSignature({
        ...msgA,
        text: '正文已更新',
        blocks: [{ type: 'text', content: '正文已更新' }],
      });
      expect(sigA).not.toBe(sigTextChanged);
    });
  });

  /**
   * 防回归：2026-09-19 真实宿主实证的内容丢失事故。
   *
   * 事故链：store 消息对象经 immer auto-freeze 后为只读 → buildAssistantTimeline
   * 对 toolCall 原地补 durationMs（`tc.durationMs = b.durationMs`）→ ES module
   * 严格模式抛 `TypeError: Cannot add property durationMs, object is not extensible`
   * → 被函数内 catch 吞掉 → 降级为「只渲染正文」→ 思考行与工具块整体消失。
   *
   * 契约：渲染投影必须对入参只读；frozen 输入不得抛错、不得降级。
   */
  describe('只读契约（frozen 输入防回归）', () => {
    function deepFreeze<T>(o: T): T {
      if (o && typeof o === 'object') {
        Object.values(o as Record<string, unknown>).forEach(deepFreeze);
        Object.freeze(o);
      }
      return o;
    }

    function makeFrozenTimelineMessage(): SessionMessage {
      const toolCall = makeToolCall({
        id: 'tc-frozen-1',
        name: 'project_tree',
        status: 'success',
        startedAt: 1700000000000,
        // 关键：durationMs 缺失，而 block.durationMs 存在（0）→ 旧实现触发原地赋值
      });
      return deepFreeze(
        makeMessage({
          id: 'asst-frozen-1',
          sender: 'assistant',
          status: 'completed',
          text: '正文 1\n\n正文 2',
          thinking: '思考内容',
          toolCalls: [toolCall],
          blocks: [
            { type: 'thought', id: 'thought-turn-0', content: '思考内容', turnIndex: 0 },
            { type: 'text', content: '正文 1', turnIndex: 0 },
            { type: 'tool_call', id: 'tc-frozen-1', durationMs: 0, turnIndex: 0 },
            { type: 'text', content: '正文 2', turnIndex: 0 },
          ] as SessionMessage['blocks'],
        })
      );
    }

    it('frozen 输入下不得抛错（旧实现因原地赋值抛 TypeError 被 catch 吞掉）', () => {
      expect(() => buildAssistantTimeline(makeFrozenTimelineMessage())).not.toThrow();
    });

    it('frozen 输入下仍产出 thought / tools / text 三段（不得降级为 text-fallback）', () => {
      const items = buildAssistantTimeline(makeFrozenTimelineMessage());
      const kinds = items.map((i) => i.kind);
      expect(kinds).toContain('thought');
      expect(kinds).toContain('tools');
      expect(kinds).toContain('text');
      // 降级路径的特征 key
      expect(items.some((i) => i.key === 'text-fallback')).toBe(false);
    });

    it('不得原地修改入参（数据层 toolCall 的 durationMs 保持缺失）', () => {
      const msg = makeFrozenTimelineMessage();
      buildAssistantTimeline(msg);
      expect(msg.toolCalls?.[0]?.durationMs).toBeUndefined();
    });

    it('补齐的时间戳只落在投影产物上，绝不写回数据层', () => {
      const msg = makeFrozenTimelineMessage();
      const items = buildAssistantTimeline(msg);
      const toolsItem = items.find((i) => i.kind === 'tools');
      expect(toolsItem).toBeDefined();
      const rendered = (toolsItem as { items: unknown[] }).items;
      expect(rendered.length).toBeGreaterThan(0);
      expect(msg.toolCalls?.[0]?.durationMs).toBeUndefined();
    });
  });
});
