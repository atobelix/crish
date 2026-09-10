/**
 * 时间线 Blocks 保全合并算法与 Store 状态机防退避单测（timelineBlocksReconcile.test.ts）。
 *
 * 核心目标：
 * 1. 验证三元锚点保全算法 (reconcileAssistantMessageBlocks)：以 (turnIndex, type, id) 为三元槽位，
 *    在多轮交互与时间线归一化过程中，历史思考块 (thought) 与工具卡片 (tool_call) 100% 留存，零丢失。
 * 2. 【Anti-Regression Checklist 防退避红线】：
 *    - 绝不允许在 updateMessageTimeline / normalizeAssistantTimeline 时丢弃 thought 块；
 *    - 绝不允许通过 filter(b => b.type === 'tool_call') 破坏交错时间线；
 *    - 多轮连续触发 updateMessageTimeline 具备严格幂等性，不产生重复块或结构退化。
 * 3. 端到端 Store 消息流转：
 *    - 模拟 5 轮复杂的 Agent 工具调用与思考链写入，断言最终消息结构包含全部 5 轮的 ThoughtBlock 与 ToolCallCard。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore } from '../sessionStore';
import type {
  MessageTimelineBlock,
  MessageToolCall,
  SessionMessage,
  SessionState,
} from '../types';
import {
  alignToolCallBlocks,
  buildAssistantTimeline,
  normalizeAssistantTimeline,
  reconcileAssistantMessageBlocks,
} from '../../api/tool-presentation/timelineNormalizer';
import { parseSessionMessage } from '../../api/session-persistence/sessionHydrationMessages';
import { projectEventsToMessages } from '../../api/sessionEventProjection';

function makeToolCall(
  partial: Partial<MessageToolCall> &
    Pick<MessageToolCall, 'id' | 'name' | 'status'>
): MessageToolCall {
  return {
    arguments: '{}',
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

describe('时间线 Blocks 保全合并算法与防退避测试套件', () => {
  const SESS_ID = 'sess-timeline-reconcile';
  const MSG_ID = 'asst-msg-timeline-1';

  function seedSession(msgs: SessionMessage[] = []) {
    const session = {
      id: SESS_ID,
      title: '时间线保全合并会话',
      folder: '常规会话',
      isPinned: false,
      isArchived: false,
      timestamp: new Date().toISOString(),
      messages: msgs,
    } as unknown as SessionState;
    useSessionStore.setState((st) => {
      st.sessions = [...st.sessions.filter((s) => s.id !== SESS_ID), session];
      st.sessionsById[SESS_ID] = session;
    });
  }

  beforeEach(() => {
    seedSession([
      makeMessage({
        id: MSG_ID,
        sender: 'assistant',
        text: '',
        status: 'processing',
        blocks: [],
        toolCalls: [],
      }),
    ]);
  });

  afterEach(() => {
    useSessionStore.setState((st) => {
      st.sessions = st.sessions.filter((s) => s.id !== SESS_ID);
      delete st.sessionsById[SESS_ID];
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 1. reconcileAssistantMessageBlocks 算法纯函数三元槽位保全断言
  // ──────────────────────────────────────────────────────────────────────────
  describe('reconcileAssistantMessageBlocks 三元槽位保全纯函数', () => {
    it('初次写入：无 existingBlocks 时直接返回 incomingBlocks', () => {
      const incoming: MessageTimelineBlock[] = [
        { type: 'thought', content: '思考步骤 1', turnIndex: 0 },
        { type: 'tool_call', id: 't1', turnIndex: 0 },
        { type: 'text', content: '第一阶段正文', turnIndex: 0 },
      ];
      const result = reconcileAssistantMessageBlocks(undefined, incoming);
      expect(result).toEqual(incoming);
    });

    it('跨轮多步骤合并：第 2 轮到达时，第 1 轮的 thought 与 tool_call 100% 留存', () => {
      const existing: MessageTimelineBlock[] = [
        { type: 'thought', content: '第 1 轮思考：扫描工作区', turnIndex: 0 },
        { type: 'tool_call', id: 'tc-scan', turnIndex: 0 },
        { type: 'text', content: '扫描中...', turnIndex: 0 },
      ];

      const incoming: MessageTimelineBlock[] = [
        { type: 'thought', content: '第 2 轮思考：读取配置文件', turnIndex: 1 },
        { type: 'tool_call', id: 'tc-read', turnIndex: 1 },
        { type: 'text', content: '配置文件读取完毕。', turnIndex: 1 },
      ];

      const merged = reconcileAssistantMessageBlocks(existing, incoming);

      // 验证第 1 轮与第 2 轮所有 thought 与 tool_call 卡片完整保留（内容完整性）
      const thoughtContents = merged
        .filter((b) => b.type === 'thought')
        .map((b) => b.content);
      // 插入顺序：incoming turn1 先到，orphan turn0 追加到末尾
      expect(thoughtContents).toEqual([
        '第 2 轮思考：读取配置文件',
        '第 1 轮思考：扫描工作区',
      ]);

      const toolCallIds = merged
        .filter((b) => b.type === 'tool_call')
        .map((b) => b.id);
      // 工具同上：tc-read 先（incoming），tc-scan 后（orphan）
      expect(toolCallIds).toEqual(['tc-read', 'tc-scan']);

      // 验证物理逻辑顺序：incoming 块在前（按到达顺序），orphan 历史块追加到末尾
      // 新实现严格按插入顺序：incoming=[turn1.thought, turn1.tool_call, turn1.text]，then orphans=[turn0.thought, turn0.tool_call]
      expect(merged.map((b) => `${b.turnIndex}:${b.type}`)).toEqual([
        '1:thought',
        '1:tool_call',
        '1:text',
        '0:thought',
        '0:tool_call',
      ]);
    });

    it('同槽位 (turnIndex, type, id) 更新：内容原地覆盖，绝对不复制出冗余块', () => {
      const existing: MessageTimelineBlock[] = [
        {
          type: 'thought',
          id: 'th-1',
          content: '正在思考（流式中）...',
          turnIndex: 0,
          isStreaming: true,
        },
        { type: 'tool_call', id: 'tc-1', turnIndex: 0 },
      ];

      const incoming: MessageTimelineBlock[] = [
        {
          type: 'thought',
          id: 'th-1',
          content: '思考完毕：明确执行策略',
          turnIndex: 0,
          isStreaming: false,
        },
        { type: 'tool_call', id: 'tc-1', turnIndex: 0 },
      ];

      const merged = reconcileAssistantMessageBlocks(existing, incoming);

      expect(merged).toHaveLength(2);
      expect(merged[0]).toMatchObject({
        type: 'thought',
        id: 'th-1',
        content: '思考完毕：明确执行策略',
        isStreaming: false,
      });
      expect(merged[1]).toMatchObject({
        type: 'tool_call',
        id: 'tc-1',
      });
    });

    it('【Anti-Regression 防退避红线】：即便 incoming 遗漏历史 thought 块，历史 thought 也绝不丢失', () => {
      // 模拟某些上游或归一器仅回传了当前轮次的 tool_calls
      const existing: MessageTimelineBlock[] = [
        { type: 'thought', content: '历史第 0 轮思考', turnIndex: 0 },
        { type: 'tool_call', id: 'tc-0', turnIndex: 0 },
        { type: 'thought', content: '历史第 1 轮思考', turnIndex: 1 },
        { type: 'tool_call', id: 'tc-1', turnIndex: 1 },
      ];

      // incoming 仅包含第 2 轮
      const incoming: MessageTimelineBlock[] = [
        { type: 'thought', content: '当前第 2 轮思考', turnIndex: 2 },
        { type: 'tool_call', id: 'tc-2', turnIndex: 2 },
        { type: 'text', content: '全部操作完成', turnIndex: 2 },
      ];

      const merged = reconcileAssistantMessageBlocks(existing, incoming);

      // 全部 3 轮 thought 与 3 轮 tool_call 必须 100% 存留（内容完整性断言）
      const thoughts = merged.filter((b) => b.type === 'thought');
      expect(thoughts).toHaveLength(3);
      // 插入顺序：incoming 中的 turn2 先出现，orphan 的 turn0/turn1 追加到末尾
      expect(thoughts.map((t) => t.content)).toEqual([
        '当前第 2 轮思考',
        '历史第 0 轮思考',
        '历史第 1 轮思考',
      ]);

      const tools = merged.filter((b) => b.type === 'tool_call');
      expect(tools).toHaveLength(3);
      // 工具顺序同上：tc-2 先出（incoming），tc-0/tc-1 后追（orphan）
      expect(tools.map((t) => t.id)).toEqual(['tc-2', 'tc-0', 'tc-1']);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. 5 轮极限 Agent 协作多步骤保全测试 (RS/TS 极限场景)
  // ──────────────────────────────────────────────────────────────────────────
  describe('5 轮极限 Agent 协作多步骤时间线保全', () => {
    it('连续 5 轮逐步推进并在每轮调用 normalizeAssistantTimeline，全部 5 轮思考与工具 0 丢失', () => {
      let currentMsg = makeMessage({
        id: 'msg-5-turns',
        sender: 'assistant',
        status: 'processing',
        text: '',
        blocks: [],
        toolCalls: [],
      });

      const turns = [
        {
          turn: 0,
          thought: '第 1 步：定位项目架构与入口',
          tool: makeToolCall({ id: 't-list', name: 'list_dir', status: 'success' }),
          text: '已获取文件列表。',
        },
        {
          turn: 1,
          thought: '第 2 步：读取核心配置文件 package.json',
          tool: makeToolCall({ id: 't-read', name: 'read_file', status: 'success' }),
          text: '已读取依赖项。',
        },
        {
          turn: 2,
          thought: '第 3 步：全局检索关键字 timeline',
          tool: makeToolCall({ id: 't-grep', name: 'grep_search', status: 'success' }),
          text: '已定位匹配行。',
        },
        {
          turn: 3,
          thought: '第 4 步：执行文件原子修改',
          tool: makeToolCall({ id: 't-edit', name: 'replace_file_content', status: 'success' }),
          text: '已更新文件内容。',
        },
        {
          turn: 4,
          thought: '第 5 步：运行自动化测试验证',
          tool: makeToolCall({ id: 't-test', name: 'run_command', status: 'success' }),
          text: '全链路验证通过，任务完成！',
        },
      ];

      // 逐步注入 5 轮
      for (const t of turns) {
        const nextBlocks: MessageTimelineBlock[] = [
          ...(currentMsg.blocks || []),
          { type: 'thought', content: t.thought, turnIndex: t.turn },
          { type: 'tool_call', id: t.tool.id, turnIndex: t.turn },
          { type: 'text', content: t.text, turnIndex: t.turn },
        ];
        const nextToolCalls = [...(currentMsg.toolCalls || []), t.tool];

        currentMsg = {
          ...currentMsg,
          blocks: nextBlocks,
          toolCalls: nextToolCalls,
          text: turns
            .slice(0, t.turn + 1)
            .map((item) => item.text)
            .join('\n\n'),
        };

        // 每轮均执行归一化
        currentMsg = normalizeAssistantTimeline(currentMsg);
      }

      // 终态收口
      currentMsg.status = 'completed';
      const finalized = normalizeAssistantTimeline(currentMsg);

      // 断言 1：包含全部 5 轮的 ThoughtBlock
      const finalThoughts = finalized.blocks?.filter((b) => b.type === 'thought') || [];
      expect(finalThoughts).toHaveLength(5);
      for (let i = 0; i < 5; i++) {
        expect(finalThoughts[i]?.content).toBe(turns[i]?.thought);
        expect(finalThoughts[i]?.turnIndex).toBe(i);
      }

      // 断言 2：包含全部 5 轮的 ToolCallCard
      const finalToolBlocks = finalized.blocks?.filter((b) => b.type === 'tool_call') || [];
      expect(finalToolBlocks).toHaveLength(5);
      expect(finalToolBlocks.map((b) => b.id)).toEqual([
        't-list',
        't-read',
        't-grep',
        't-edit',
        't-test',
      ]);

      expect(finalized.toolCalls).toHaveLength(5);
      expect(finalized.toolCalls?.map((tc) => tc.id)).toEqual([
        't-list',
        't-read',
        't-grep',
        't-edit',
        't-test',
      ]);

      // 断言 3：buildAssistantTimeline 投影渲染层产出结构化 Items 序列，0 乱序 0 丢失
      const timelineItems = buildAssistantTimeline(finalized);
      expect(timelineItems.length).toBeGreaterThanOrEqual(10);

      const thoughtItems = timelineItems.filter((item) => item.kind === 'thought');
      expect(thoughtItems).toHaveLength(5);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Store updateMessageTimeline 集成与幂等保全验证
  // ──────────────────────────────────────────────────────────────────────────
  describe('SessionStore updateMessageTimeline 动作集成与幂等性', () => {
    it('在 store 中逐步触发 addMessageToolCall 与 updateMessageTimeline，多轮状态 100% 完好', () => {
      const store = useSessionStore.getState();

      // ── Turn 0 ──
      store.addMessageToolCall(SESS_ID, MSG_ID, {
        id: 'tc-step-0',
        name: 'fetch_schema',
        status: 'running',
        arguments: '{"uri":"schema.json"}',
      });
      // 经 canonical sessions[] 写入思考块（immer draft 原地修改）
      useSessionStore.setState((st) => {
        const sess = st.sessions.find((s) => s.id === SESS_ID);
        const msg = sess?.messages.find((m) => m.id === MSG_ID);
        if (msg) {
          msg.blocks = [
            { type: 'thought', content: 'Turn 0 思考：获取元数据', turnIndex: 0 },
            { type: 'tool_call', id: 'tc-step-0', turnIndex: 0 },
          ];
        }
      });
      store.updateMessageTimeline(SESS_ID, MSG_ID);

      // ── Turn 1 ──
      store.addMessageToolCall(SESS_ID, MSG_ID, {
        id: 'tc-step-1',
        name: 'validate_schema',
        status: 'success',
        output: 'valid',
      });
      useSessionStore.setState((st) => {
        const sess = st.sessions.find((s) => s.id === SESS_ID);
        const msg = sess?.messages.find((m) => m.id === MSG_ID);
        if (msg && msg.blocks) {
          msg.blocks.push({
            type: 'thought',
            content: 'Turn 1 思考：执行校验',
            turnIndex: 1,
          });
        }
      });
      store.updateMessageTimeline(SESS_ID, MSG_ID);

      // ── Turn 2 ──
      store.addMessageToolCall(SESS_ID, MSG_ID, {
        id: 'tc-step-2',
        name: 'save_schema',
        status: 'success',
        output: 'saved',
      });
      useSessionStore.setState((st) => {
        const sess = st.sessions.find((s) => s.id === SESS_ID);
        const msg = sess?.messages.find((m) => m.id === MSG_ID);
        if (msg && msg.blocks) {
          msg.blocks.push({
            type: 'thought',
            content: 'Turn 2 思考：保存成果',
            turnIndex: 2,
          });
          msg.text = 'Schema 已成功验证并保存。';
        }
      });
      store.updateMessageTimeline(SESS_ID, MSG_ID);

      // ── 连续重复触发 10 次 updateMessageTimeline 验证幂等性 ──
      for (let i = 0; i < 10; i++) {
        store.updateMessageTimeline(SESS_ID, MSG_ID);
      }

      const finalMsg = useSessionStore
        .getState()
        .sessionsById[SESS_ID]?.messages.find((m) => m.id === MSG_ID);

      expect(finalMsg).toBeDefined();
      if (!finalMsg) throw new Error('finalMsg not found');

      // 验证 toolCalls 数量与状态
      expect(finalMsg.toolCalls).toHaveLength(3);
      expect(finalMsg.toolCalls?.map((t) => t.id)).toEqual([
        'tc-step-0',
        'tc-step-1',
        'tc-step-2',
      ]);

      // 验证 thought 块全量留存
      const thoughts = finalMsg.blocks?.filter((b) => b.type === 'thought') || [];
      expect(thoughts).toHaveLength(3);
      expect(thoughts.map((t) => t.content)).toEqual([
        'Turn 0 思考：获取元数据',
        'Turn 1 思考：执行校验',
        'Turn 2 思考：保存成果',
      ]);

      // 验证 tool_call 块全量留存
      const toolBlocks = finalMsg.blocks?.filter((b) => b.type === 'tool_call') || [];
      expect(toolBlocks).toHaveLength(3);
      expect(toolBlocks.map((b) => b.id)).toEqual([
        'tc-step-0',
        'tc-step-1',
        'tc-step-2',
      ]);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. alignToolCallBlocks 与 Ghost Tool 防御
  // ──────────────────────────────────────────────────────────────────────────
  describe('alignToolCallBlocks 与幽灵工具防御', () => {
    it('剔除不在 tools 列表内的幽灵 tool_call 块，但绝对不误伤 thought 块', () => {
      const blocks: MessageTimelineBlock[] = [
        { type: 'thought', content: '保留思考 1', turnIndex: 0 },
        { type: 'tool_call', id: 'ghost-tc-99', turnIndex: 0 },
        { type: 'thought', content: '保留思考 2', turnIndex: 1 },
        { type: 'tool_call', id: 'valid-tc-1', turnIndex: 1 },
      ];

      const validTools = [
        makeToolCall({ id: 'valid-tc-1', name: 'read', status: 'success' }),
      ];

      const aligned = alignToolCallBlocks(blocks, validTools);

      expect(aligned.map((b) => (b.type === 'tool_call' ? b.id : b.type))).toEqual([
        'thought',
        'thought',
        'valid-tc-1',
      ]);

      const thoughts = aligned.filter((b) => b.type === 'thought');
      expect(thoughts).toHaveLength(2);
      expect(thoughts[0]?.content).toBe('保留思考 1');
      expect(thoughts[1]?.content).toBe('保留思考 2');
    });

    it('在仅有 text 块与 thought 块时，正确注入缺失的 tool_call 块且保全两者', () => {
      const blocks: MessageTimelineBlock[] = [
        { type: 'thought', content: '分析中', turnIndex: 0 },
        { type: 'text', content: '准备就绪', turnIndex: 0 },
      ];

      const tools = [
        makeToolCall({ id: 'injected-tool', name: 'search', status: 'running' }),
      ];

      const aligned = alignToolCallBlocks(blocks, tools);

      expect(aligned.map((b) => b.type)).toEqual([
        'thought',
        'tool_call',
        'text',
      ]);
      expect(aligned[1]).toEqual({ type: 'tool_call', id: 'injected-tool' });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. 因果先后时序与 updateMessageText 防正文克隆验证
  // ──────────────────────────────────────────────────────────────────────────
  describe('因果先后时序与 updateMessageText 防正文克隆验证', () => {
    it('normalizeAssistantTimeline 从 msg.thinking 补偿思考块时，严格放置在首个 text 块之前，绝不追加到正文之后', () => {
      const msg = makeMessage({
        id: 'msg-causal-order',
        sender: 'assistant',
        text: '这是完整的回答正文',
        thinking: '这是先前的思考过程',
        blocks: [{ type: 'text', content: '这是完整的回答正文' }],
      });

      const normalized = normalizeAssistantTimeline(msg);
      expect(normalized.blocks).toHaveLength(2);
      expect(normalized.blocks![0]).toMatchObject({
        type: 'thought',
        content: '这是先前的思考过程',
      });
      expect(normalized.blocks![1]).toMatchObject({
        type: 'text',
        content: '这是完整的回答正文',
      });
    });

    it('updateMessageText 在 blocks 存在 thought 等非 text 块时多次触发，严格就地更新正文块，绝不重复追加', () => {
      seedSession([
        makeMessage({
          id: MSG_ID,
          sender: 'assistant',
          text: '',
          thinking: '思考中…',
          blocks: [
            { type: 'thought', content: '思考完成', turnIndex: 0 },
          ],
        }),
      ]);
      const store = useSessionStore.getState();

      // 第一次写入正文（流式进行中）
      store.updateMessageText(SESS_ID, MSG_ID, '你好，我是 AI 助手。');
      let currentMsg = useSessionStore.getState().sessionsById[SESS_ID]?.messages.find((m) => m.id === MSG_ID);
      expect(currentMsg?.blocks?.filter((b) => b.type === 'text')).toHaveLength(1);

      // 第二次写入正文（尾帧收口或清理占位符）
      store.updateMessageText(SESS_ID, MSG_ID, '你好，我是 AI 助手。有什么我可以帮你的吗？');
      currentMsg = useSessionStore.getState().sessionsById[SESS_ID]?.messages.find((m) => m.id === MSG_ID);
      expect(currentMsg?.blocks?.filter((b) => b.type === 'text')).toHaveLength(1);
      expect(currentMsg?.blocks?.find((b) => b.type === 'text')?.content).toBe(
        '你好，我是 AI 助手。有什么我可以帮你的吗？'
      );

      // 第三次重复触发相同文本写入（模拟幂等与收口多次触发）
      store.updateMessageText(SESS_ID, MSG_ID, '你好，我是 AI 助手。有什么我可以帮你的吗？');
      currentMsg = useSessionStore.getState().sessionsById[SESS_ID]?.messages.find((m) => m.id === MSG_ID);
      expect(currentMsg?.blocks?.filter((b) => b.type === 'text')).toHaveLength(1);

      // 整体结构：thought 必然在 text 之前
      expect(currentMsg?.blocks?.map((b) => b.type)).toEqual(['thought', 'text']);
    });

    it('normalizeAssistantTimeline 自动自愈因历史缺陷误置于工具之后的 thought-legacy 块并移回首位', () => {
      const msg = makeMessage({
        id: 'msg-legacy-heal',
        sender: 'assistant',
        toolCalls: [
          makeToolCall({ id: 'tc-1', name: 'cmd-1', status: 'success' }),
          makeToolCall({ id: 'tc-2', name: 'cmd-2', status: 'success' }),
        ],
        blocks: [
          { type: 'tool_call', id: 'tc-1', turnIndex: 0 },
          { type: 'tool_call', id: 'tc-2', turnIndex: 0 },
          { type: 'thought', id: 'thought-legacy', content: '旧版误置的思考', turnIndex: 0 },
          { type: 'text', content: '最终回复正文', turnIndex: 0 },
        ],
      });

      const normalized = normalizeAssistantTimeline(msg);
      expect(normalized.blocks?.map((b) => b.type)).toEqual([
        'thought',
        'tool_call',
        'tool_call',
        'text',
      ]);
      expect(normalized.blocks?.[0]?.content).toBe('旧版误置的思考');
    });

    it('parseSessionMessage 在持久化重水合时不丢弃 thought 与 context_injection 块，并保留 thinkingTurns', () => {
      const raw = {
        id: 'msg-hydrate-test',
        sender: 'assistant',
        timestamp: Date.now(),
        text: '回复正文',
        thinking: '第二轮思考',
        blocks: [
          { type: 'thought', id: 'thought-turn-0', content: '第一轮思考', turnIndex: 0 },
          { type: 'tool_call', id: 't-1', turnIndex: 0 },
          { type: 'thought', id: 'thought-turn-1', content: '第二轮思考', turnIndex: 1 },
          { type: 'text', content: '回复正文', turnIndex: 1 },
        ],
      };

      const parsed = parseSessionMessage(raw);
      expect(parsed?.blocks).toHaveLength(4);
      expect(parsed?.blocks?.map((b) => b.type)).toEqual([
        'thought',
        'tool_call',
        'thought',
        'text',
      ]);
      expect(parsed?.thinkingTurns).toHaveLength(2);
      expect(parsed?.thinkingTurns?.[0]?.content).toBe('第一轮思考');
      expect(parsed?.thinkingTurns?.[1]?.content).toBe('第二轮思考');
    });

    it('projectEventsToMessages 投影多轮 message-end 与工具事件，严格输出交错时间线零丢失', () => {
      const events = [
        {
          sequence: 1,
          type: 'runtime-event',
          payload: {
            event: {
              type: 'message-end',
              turnIndex: 1,
              runId: 'r1',
              message: {
                role: 'assistant',
                clientMessageId: 'asst-1',
                blocks: [
                  { type: 'thought', text: '分析代码结构' },
                  { type: 'text', text: '我来查看文件：' },
                ],
              },
            },
          },
        },
        {
          sequence: 2,
          type: 'runtime-event',
          payload: {
            event: {
              type: 'tool-start',
              call: { id: 'call-1', name: 'read_file', args: '{}' },
              turnIndex: 1,
            },
          },
        },
        {
          sequence: 3,
          type: 'runtime-event',
          payload: {
            event: {
              type: 'tool-end',
              result: { id: 'call-1', text: '文件内容', isError: false },
            },
          },
        },
        {
          sequence: 4,
          type: 'runtime-event',
          payload: {
            event: {
              type: 'message-end',
              turnIndex: 2,
              runId: 'r1',
              message: {
                role: 'assistant',
                clientMessageId: 'asst-1',
                blocks: [
                  { type: 'thought', text: '文件已读取完毕，正在给出结论' },
                  { type: 'text', text: '分析完成，结果如下。' },
                ],
              },
            },
          },
        },
      ];

      const { messages } = projectEventsToMessages(events);
      expect(messages).toHaveLength(1);
      const asst = messages[0]!;
      expect(asst.blocks?.map((b) => b.type)).toEqual([
        'thought',
        'text',
        'tool_call',
        'thought',
        'text',
      ]);
      expect(asst.thinkingTurns).toHaveLength(2);
      expect(asst.thinkingTurns?.[0]?.content).toBe('分析代码结构');
      expect(asst.thinkingTurns?.[1]?.content).toBe('文件已读取完毕，正在给出结论');

      // 验证渲染视图 timeline 自然交错
      const timeline = buildAssistantTimeline(asst);
      expect(timeline.map((t) => t.kind)).toEqual([
        'thought',
        'text',
        'tools',
        'thought',
        'text',
      ]);
    });
  });
});
