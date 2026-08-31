/**
 * messageHandlers 消息域幂等性与单生产者防线测试（Wave 1 防退避验证）。
 *
 * 核心断言：
 * 1. 单增量生产者铁律 (Single Producer Invariant)：
 *    - onMessageDelta 正常递增触发 callbacks.onChunk；
 *    - onMessageEnd 即使被重复调用 1 次、2 次或 3 次（模拟多轮收口/网络重试），
 *      也绝对不额外调用 callbacks.onChunk（调用次数严格为 0），state.assistantText 严格无重复。
 * 2. 多轮（turnIndex > 0）与多工具调用交错：
 *    - 多轮按 turnIndex 分段合并（G4 / 04 §5.2-5），无千字大段重复两遍缺陷；
 *    - 思考链标签/内容在流式增量与终态覆盖下严格幂等。
 * 3. 边界场景：
 *    - 终态权威文本写入（state.assistantText 采用 message-end 权威内容，onChunk 0 调用）；
 *    - Gateway 累积全量 content 回显切片。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalFlowMachine } from '../../../approvalFlowMachine';
import type { StreamCallbacks } from '../../../chatApi';
import { parseBridgeEvent } from '../eventParser';
import { dispatchEvent } from '../dispatch';
import { onMessageDelta, onMessageEnd } from '../messageHandlers';
import type { HandlerEnv } from '../handlerEnv';
import type { StreamState } from '../streamState';
import { useSessionStore } from '../../../../store/sessionStore';
import type { SessionMessage, SessionState } from '../../../../store/types';

function makeEnv(sessionId = 'sess-idempotent-test') {
  const state: StreamState = {
    cancelled: false,
    finished: false,
    assistantText: '',
    assistantThought: '',
    unsub: null,
    endTimer: null,
  };
  const callbacks: StreamCallbacks = {
    onThought: vi.fn(),
    onToolStart: vi.fn(),
    onToolSuccess: vi.fn(),
    onToolError: vi.fn(),
    onChunk: vi.fn(),
    onComplete: vi.fn(),
    onRunError: vi.fn(),
    onToolPendingApproval: vi.fn(),
    onTerminalLine: vi.fn(),
    onRunMeta: vi.fn(),
    onApprovalResolved: vi.fn(),
    onSubagentStarted: vi.fn(),
    onSubagentEvent: vi.fn(),
    onSubagentEnded: vi.fn(),
  };
  const approvalFlow = new ApprovalFlowMachine();
  const finish = vi.fn();
  const tryResumeFinish = vi.fn();
  const client = { send: vi.fn() };
  const env: HandlerEnv = {
    state,
    approvalFlow,
    callbacks,
    runId: 'run-idempotent-test',
    sessionId,
    finish,
    tryResumeFinish,
    client,
  };
  return { env, state, callbacks, approvalFlow };
}

describe('messageHandlers 幂等性与单生产者防线（messageHandlers.idempotent.test.ts）', () => {
  const SESS_ID = 'sess-idempotent-main';
  const MSG_ID = 'asst-msg-idempotent-1';

  function seedSession(msgs: SessionMessage[] = []) {
    const session = {
      id: SESS_ID,
      title: '幂等性单测会话',
      folder: '常规会话',
      isPinned: false,
      isArchived: false,
      timestamp: new Date().toISOString(),
      messages: msgs,
    } as unknown as SessionState;
    useSessionStore.setState((st) => ({
      sessions: [...st.sessions.filter((s) => s.id !== SESS_ID), session],
      sessionsById: { ...st.sessionsById, [SESS_ID]: session },
    }));
  }

  beforeEach(() => {
    seedSession([
      {
        id: MSG_ID,
        sender: 'assistant',
        text: '',
        status: 'processing',
        timestamp: Date.now(),
        blocks: [],
      },
    ]);
  });

  afterEach(() => {
    useSessionStore.setState((st) => {
      const next = { ...st.sessionsById };
      delete next[SESS_ID];
      return {
        sessions: st.sessions.filter((s) => s.id !== SESS_ID),
        sessionsById: next,
      };
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 1. 单轮纯文本流式与 onMessageEnd 幂等收口
  // ──────────────────────────────────────────────────────────────────────────
  describe('单轮纯文本流式与 onMessageEnd 幂等收口', () => {
    it('onMessageDelta 逐字增量递增调用 onChunk，累积文本严格精确', () => {
      const { env, state, callbacks } = makeEnv(SESS_ID);
      const chunks = ['你好', '，', '我是', ' Crish', ' 智能助手。'];

      for (const c of chunks) {
        const parsed = parseBridgeEvent({
          type: 'message-delta',
          sessionId: SESS_ID,
          timestamp: new Date().toISOString(),
          messageId: MSG_ID,
          block: { type: 'text', text: c },
        });
        expect(parsed.ok).toBe(true);
        if (parsed.ok) dispatchEvent(env, parsed.data);
      }

      expect(callbacks.onChunk).toHaveBeenCalledTimes(5);
      expect(vi.mocked(callbacks.onChunk).mock.calls.map((call) => call[0])).toEqual(chunks);
      expect(state.assistantText).toBe('你好，我是 Crish 智能助手。');
    });

    it('onMessageEnd 被连续调用 1 次、2 次、3 次，绝不额外调用 onChunk，assistantText 保持无重复', () => {
      const { env, state, callbacks } = makeEnv(SESS_ID);
      const chunks = ['第一部分', '，', '第二部分。'];
      for (const c of chunks) {
        const parsed = parseBridgeEvent({
          type: 'message-delta',
          sessionId: SESS_ID,
          timestamp: new Date().toISOString(),
          messageId: MSG_ID,
          block: { type: 'text', text: c },
        });
        if (parsed.ok) dispatchEvent(env, parsed.data);
      }

      const initialChunkCalls = vi.mocked(callbacks.onChunk).mock.calls.length;
      expect(initialChunkCalls).toBe(3);
      expect(state.assistantText).toBe('第一部分，第二部分。');

      const messageEndPayload = {
        type: 'message-end',
        sessionId: SESS_ID,
        timestamp: new Date().toISOString(),
        turnIndex: 0,
        message: {
          id: MSG_ID,
          role: 'assistant',
          createdAt: new Date().toISOString(),
          content: '第一部分，第二部分。',
          blocks: [{ type: 'text', text: '第一部分，第二部分。' }],
        },
      };

      // ── 第 1 次调用 onMessageEnd ──
      const parsedEnd1 = parseBridgeEvent(messageEndPayload);
      expect(parsedEnd1.ok).toBe(true);
      if (parsedEnd1.ok) dispatchEvent(env, parsedEnd1.data);

      expect(callbacks.onChunk).toHaveBeenCalledTimes(initialChunkCalls);
      expect(state.assistantText).toBe('第一部分，第二部分。');

      // ── 第 2 次调用 onMessageEnd（模拟多重事件或网络收口重试）──
      const parsedEnd2 = parseBridgeEvent(messageEndPayload);
      expect(parsedEnd2.ok).toBe(true);
      if (parsedEnd2.ok) dispatchEvent(env, parsedEnd2.data);

      expect(callbacks.onChunk).toHaveBeenCalledTimes(initialChunkCalls);
      expect(state.assistantText).toBe('第一部分，第二部分。');

      // ── 第 3 次调用 onMessageEnd（极限幂等验证）──
      const parsedEnd3 = parseBridgeEvent(messageEndPayload);
      expect(parsedEnd3.ok).toBe(true);
      if (parsedEnd3.ok) dispatchEvent(env, parsedEnd3.data);

      expect(callbacks.onChunk).toHaveBeenCalledTimes(initialChunkCalls);
      expect(state.assistantText).toBe('第一部分，第二部分。');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. 思考链 (Thought) 流式累积与 onMessageEnd 幂等
  // ──────────────────────────────────────────────────────────────────────────
  describe('思考链 (Thought) 增量与 onMessageEnd 幂等收口', () => {
    it('thought 块通过 onMessageDelta 累积并触发 onThought，不污染 onChunk', () => {
      const { env, state, callbacks } = makeEnv(SESS_ID);

      const thoughtDeltas = ['我正在分析', '项目代码结构', '并准备调用工具。'];
      for (const td of thoughtDeltas) {
        const parsed = parseBridgeEvent({
          type: 'message-delta',
          sessionId: SESS_ID,
          timestamp: new Date().toISOString(),
          messageId: MSG_ID,
          block: { type: 'thought', text: td },
        });
        if (parsed.ok) dispatchEvent(env, parsed.data);
      }

      expect(callbacks.onThought).toHaveBeenCalledTimes(3);
      expect(callbacks.onChunk).toHaveBeenCalledTimes(0);
      expect(state.assistantThought).toBe('我正在分析项目代码结构并准备调用工具。');
      expect(state.assistantText).toBe('');
    });

    it('onMessageEnd 携带已累积的思考内容时保持幂等，连续 3 次调用不重复拼接', () => {
      const { env, state, callbacks } = makeEnv(SESS_ID);

      // 流式写入思考与正文
      const thoughtText = '思考：需要先查询文件列表';
      const parsedThought = parseBridgeEvent({
        type: 'message-delta',
        sessionId: SESS_ID,
        timestamp: new Date().toISOString(),
        messageId: MSG_ID,
        block: { type: 'thought', text: thoughtText },
      });
      if (parsedThought.ok) dispatchEvent(env, parsedThought.data);

      const parsedText = parseBridgeEvent({
        type: 'message-delta',
        sessionId: SESS_ID,
        timestamp: new Date().toISOString(),
        messageId: MSG_ID,
        block: { type: 'text', text: '准备就绪。' },
      });
      if (parsedText.ok) dispatchEvent(env, parsedText.data);

      const endPayload = {
        type: 'message-end',
        sessionId: SESS_ID,
        timestamp: new Date().toISOString(),
        turnIndex: 0,
        message: {
          id: MSG_ID,
          role: 'assistant',
          createdAt: new Date().toISOString(),
          content: '准备就绪。',
          blocks: [
            { type: 'thought', text: thoughtText },
            { type: 'text', text: '准备就绪。' },
          ],
        },
      };

      // 连续 3 次收口
      for (let i = 1; i <= 3; i++) {
        const parsed = parseBridgeEvent(endPayload);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) dispatchEvent(env, parsed.data);
        expect(state.assistantThought).toBe(thoughtText);
        expect(state.assistantText).toBe('准备就绪。');
      }

      // onChunk 仅在 delta 触发 1 次，onMessageEnd 期间 0 增量
      expect(callbacks.onChunk).toHaveBeenCalledTimes(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. 多轮工具调用（Multi-Turn Tool Calls）与跨轮分段合并
  // ──────────────────────────────────────────────────────────────────────────
  describe('多轮工具调用（Multi-Turn Tool Calls）跨轮分段与幂等收口', () => {
    it('3 轮复杂工具调用场景：每轮 delta 递增派发，多轮 onMessageEnd 收口无任何重复文本', () => {
      const { env, state, callbacks } = makeEnv(SESS_ID);

      // ── Turn 0: 思考 ➔ 工具调用 ➔ 阶段回复 ──
      const turn0Thought = parseBridgeEvent({
        type: 'message-delta',
        sessionId: SESS_ID,
        timestamp: new Date().toISOString(),
        messageId: MSG_ID,
        block: { type: 'thought', text: '第一步：列出目录文件' },
      });
      if (turn0Thought.ok) dispatchEvent(env, turn0Thought.data);

      const turn0Delta = parseBridgeEvent({
        type: 'message-delta',
        sessionId: SESS_ID,
        timestamp: new Date().toISOString(),
        messageId: MSG_ID,
        block: { type: 'text', text: '正在扫描工作区目录...' },
      });
      if (turn0Delta.ok) dispatchEvent(env, turn0Delta.data);

      // Turn 0 收口（turnIndex: 0）
      const turn0EndPayload = {
        type: 'message-end',
        sessionId: SESS_ID,
        timestamp: new Date().toISOString(),
        turnIndex: 0,
        message: {
          id: MSG_ID,
          role: 'assistant',
          createdAt: new Date().toISOString(),
          content: '正在扫描工作区目录...',
          blocks: [{ type: 'text', text: '正在扫描工作区目录...' }],
        },
      };
      // 重复触发 3 次 Turn 0 收口
      for (let i = 0; i < 3; i++) {
        const parsed = parseBridgeEvent(turn0EndPayload);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) dispatchEvent(env, parsed.data);
      }
      expect(state.assistantText).toBe('正在扫描工作区目录...');

      // ── Turn 1: 工具执行完成 ➔ 分析结果 ➔ 阶段回复 ──
      const turn1Delta1 = parseBridgeEvent({
        type: 'message-delta',
        sessionId: SESS_ID,
        timestamp: new Date().toISOString(),
        messageId: MSG_ID,
        block: { type: 'text', text: '发现核心文件 index.ts，正在读取内容...' },
      });
      if (turn1Delta1.ok) dispatchEvent(env, turn1Delta1.data);

      // Turn 1 收口（turnIndex: 1）
      const turn1EndPayload = {
        type: 'message-end',
        sessionId: SESS_ID,
        timestamp: new Date().toISOString(),
        turnIndex: 1,
        message: {
          id: MSG_ID,
          role: 'assistant',
          createdAt: new Date().toISOString(),
          content: '发现核心文件 index.ts，正在读取内容...',
          blocks: [{ type: 'text', text: '发现核心文件 index.ts，正在读取内容...' }],
        },
      };
      // 重复触发 3 次 Turn 1 收口
      for (let i = 0; i < 3; i++) {
        const parsed = parseBridgeEvent(turn1EndPayload);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) dispatchEvent(env, parsed.data);
      }

      // ── Turn 2: 最终综合回复 ──
      const turn2Delta1 = parseBridgeEvent({
        type: 'message-delta',
        sessionId: SESS_ID,
        timestamp: new Date().toISOString(),
        messageId: MSG_ID,
        block: { type: 'text', text: '任务已完成：所有模块均已验证通过。' },
      });
      if (turn2Delta1.ok) dispatchEvent(env, turn2Delta1.data);

      // Turn 2 收口（turnIndex: 2）
      const turn2EndPayload = {
        type: 'message-end',
        sessionId: SESS_ID,
        timestamp: new Date().toISOString(),
        turnIndex: 2,
        message: {
          id: MSG_ID,
          role: 'assistant',
          createdAt: new Date().toISOString(),
          content: '任务已完成：所有模块均已验证通过。',
          blocks: [{ type: 'text', text: '任务已完成：所有模块均已验证通过。' }],
        },
      };
      // 重复触发 3 次 Turn 2 收口
      for (let i = 0; i < 3; i++) {
        const parsed = parseBridgeEvent(turn2EndPayload);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) dispatchEvent(env, parsed.data);
      }

      // ── 最终全文断言：三轮分段清晰以 \n\n 衔接，无千字重复 ──
      const expectedFullText = [
        '正在扫描工作区目录...',
        '发现核心文件 index.ts，正在读取内容...',
        '任务已完成：所有模块均已验证通过。',
      ].join('\n\n');

      expect(state.assistantText).toBe(expectedFullText);

      // 验证最终文本内各段落唯一出现（零重复）
      expect(state.assistantText.split('正在扫描工作区目录...').length).toBe(2);
      expect(state.assistantText.split('发现核心文件 index.ts，正在读取内容...').length).toBe(2);
      expect(state.assistantText.split('任务已完成：所有模块均已验证通过。').length).toBe(2);
    });

    it('模拟 Gateway 终态全量文本回显（piece 为完整累积文本）时不发生二次拼接', () => {
      const { env, state, callbacks } = makeEnv(SESS_ID);

      const d1 = parseBridgeEvent({
        type: 'message-delta',
        sessionId: SESS_ID,
        timestamp: new Date().toISOString(),
        messageId: MSG_ID,
        block: { type: 'text', text: '已读取 10 个数据节点。' },
      });
      if (d1.ok) dispatchEvent(env, d1.data);

      const d2 = parseBridgeEvent({
        type: 'message-delta',
        sessionId: SESS_ID,
        timestamp: new Date().toISOString(),
        messageId: MSG_ID,
        block: { type: 'text', text: ' 计算均值完毕。' },
      });
      if (d2.ok) dispatchEvent(env, d2.data);

      const fullCumulativeText = '已读取 10 个数据节点。 计算均值完毕。';
      expect(state.assistantText).toBe(fullCumulativeText);
      const chunkCountBeforeEnd = vi.mocked(callbacks.onChunk).mock.calls.length;

      // Gateway 在 message-end 发送完整全量文本
      const endEnvelope = {
        type: 'message-end',
        sessionId: SESS_ID,
        timestamp: new Date().toISOString(),
        turnIndex: 0,
        message: {
          id: MSG_ID,
          role: 'assistant',
          createdAt: new Date().toISOString(),
          content: fullCumulativeText,
          blocks: [{ type: 'text', text: fullCumulativeText }],
        },
      };

      // 触发 3 次 onMessageEnd
      for (let i = 0; i < 3; i++) {
        const parsed = parseBridgeEvent(endEnvelope);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) dispatchEvent(env, parsed.data);
      }

      // 绝对不产生任何额外 onChunk 调用
      expect(callbacks.onChunk).toHaveBeenCalledTimes(chunkCountBeforeEnd);
      expect(state.assistantText).toBe(fullCumulativeText);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. 边界防线：单增量生产者铁律与终态落盘
  // ──────────────────────────────────────────────────────────────────────────
  describe('单增量生产者铁律与终态落盘防线', () => {
    it('单增量生产者铁律：onMessageEnd 仅落盘权威文本，严格 0 调用 callbacks.onChunk', () => {
      const { env, state, callbacks } = makeEnv(SESS_ID);

      // Delta 仅流出文本
      const delta = parseBridgeEvent({
        type: 'message-delta',
        sessionId: SESS_ID,
        timestamp: new Date().toISOString(),
        messageId: MSG_ID,
        block: { type: 'text', text: '欢迎使用' },
      });
      expect(delta.ok).toBe(true);
      if (delta.ok) dispatchEvent(env, delta.data);
      expect(state.assistantText).toBe('欢迎使用');
      expect(callbacks.onChunk).toHaveBeenCalledTimes(1);

      // message-end 携带权威全文（含感叹号）
      const endEnvelope = {
        type: 'message-end',
        sessionId: SESS_ID,
        timestamp: new Date().toISOString(),
        turnIndex: 0,
        message: {
          id: MSG_ID,
          role: 'assistant',
          createdAt: new Date().toISOString(),
          content: '欢迎使用！',
          blocks: [{ type: 'text', text: '欢迎使用！' }],
        },
      };

      // 第 1 次、第 2 次、第 3 次 onMessageEnd：绝对不调用 callbacks.onChunk（0 追加）
      for (let i = 0; i < 3; i++) {
        const end = parseBridgeEvent(endEnvelope);
        expect(end.ok).toBe(true);
        if (end.ok) dispatchEvent(env, end.data);
      }

      // onChunk 保持仅在 delta 期间被调用的 1 次
      expect(callbacks.onChunk).toHaveBeenCalledTimes(1);
      // assistantText 更新为权威全文
      expect(state.assistantText).toBe('欢迎使用！');
    });

    it('当 raw.message.content 携带累积全量时，onMessageDelta 仅向 onChunk 发送增量切片', () => {
      const { env, state, callbacks } = makeEnv(SESS_ID);

      // 帧 1
      onMessageDelta(env, {
        kind: 'engine',
        type: 'message-delta',
        originalType: 'message-delta',
        event: {
          type: 'message-delta',
          sessionId: SESS_ID,
          timestamp: '',
          messageId: MSG_ID,
          block: { type: 'text', text: 'A' },
        },
        raw: {
          message: { content: 'A' },
        },
      });
      expect(callbacks.onChunk).toHaveBeenLastCalledWith('A');
      expect(state.assistantText).toBe('A');

      // 帧 2：raw.message.content 为累积全量 "AB"
      onMessageDelta(env, {
        kind: 'engine',
        type: 'message-delta',
        originalType: 'message-delta',
        event: {
          type: 'message-delta',
          sessionId: SESS_ID,
          timestamp: '',
          messageId: MSG_ID,
          block: { type: 'text', text: 'B' },
        },
        raw: {
          message: { content: 'AB' },
        },
      });
      expect(callbacks.onChunk).toHaveBeenLastCalledWith('B');
      expect(state.assistantText).toBe('AB');

      // 终态收口 3 次
      const endEnv: Parameters<typeof onMessageEnd>[1] = {
        kind: 'engine',
        type: 'message-end',
        originalType: 'message-end',
        event: {
          type: 'message-end',
          sessionId: SESS_ID,
          timestamp: '',
          turnIndex: 0,
          message: {
            id: MSG_ID,
            role: 'assistant',
            createdAt: '',
            content: 'AB',
            blocks: [{ type: 'text', text: 'AB' }],
          },
        },
        raw: {},
      };

      onMessageEnd(env, endEnv);
      onMessageEnd(env, endEnv);
      onMessageEnd(env, endEnv);

      // 总计仅 2 次 onChunk（'A' 与 'B'），收口期间 0 次
      expect(callbacks.onChunk).toHaveBeenCalledTimes(2);
      expect(state.assistantText).toBe('AB');
    });

    it('turnIndex 安全钳制：负数、NaN、非整数与字符串 turnIndex 均被安全钳制为合法索引', () => {
      const { env, state } = makeEnv(SESS_ID);

      // 1. 负数 turnIndex: -3 -> 钳制为 0
      onMessageEnd(env, {
        kind: 'engine',
        type: 'message-end',
        originalType: 'message-end',
        event: {
          type: 'message-end',
          sessionId: SESS_ID,
          timestamp: '',
          turnIndex: -3 as unknown as number,
          message: {
            id: MSG_ID,
            role: 'assistant',
            createdAt: '',
            content: '负数索引内容',
            blocks: [{ type: 'text', text: '负数索引内容' }],
          },
        },
        raw: {},
      });
      expect(state.assistantText).toBe('负数索引内容');
      expect(state.messageEndTurnSegments?.[0]).toBe('负数索引内容');

      // 2. 字符串/非整数 turnIndex: "1" -> 钳制为 1
      onMessageEnd(env, {
        kind: 'engine',
        type: 'message-end',
        originalType: 'message-end',
        event: {
          type: 'message-end',
          sessionId: SESS_ID,
          timestamp: '',
          turnIndex: '1' as unknown as number,
          message: {
            id: MSG_ID,
            role: 'assistant',
            createdAt: '',
            content: '第二轮内容',
            blocks: [{ type: 'text', text: '第二轮内容' }],
          },
        },
        raw: {},
      });
      expect(state.assistantText).toBe('负数索引内容\n\n第二轮内容');
      expect(state.messageEndTurnSegments?.[1]).toBe('第二轮内容');

      // 3. NaN turnIndex -> 钳制为 0
      onMessageEnd(env, {
        kind: 'engine',
        type: 'message-end',
        originalType: 'message-end',
        event: {
          type: 'message-end',
          sessionId: SESS_ID,
          timestamp: '',
          turnIndex: NaN,
          message: {
            id: MSG_ID,
            role: 'assistant',
            createdAt: '',
            content: '覆盖首轮内容',
            blocks: [{ type: 'text', text: '覆盖首轮内容' }],
          },
        },
        raw: {},
      });
      expect(state.assistantText).toBe('覆盖首轮内容\n\n第二轮内容');
      expect(state.messageEndTurnSegments?.[0]).toBe('覆盖首轮内容');
    });

    it('sanitizeTurnIndex 边界防御测试：全面覆盖各种非法与边缘输入', async () => {
      const { sanitizeTurnIndex } = await import('../messageHandlers');
      expect(sanitizeTurnIndex(0)).toBe(0);
      expect(sanitizeTurnIndex(3)).toBe(3);
      expect(sanitizeTurnIndex(2.99)).toBe(2);
      expect(sanitizeTurnIndex(-5)).toBe(0);
      expect(sanitizeTurnIndex(-0.5)).toBe(0);
      expect(sanitizeTurnIndex(NaN)).toBe(0);
      expect(sanitizeTurnIndex(Infinity)).toBe(0);
      expect(sanitizeTurnIndex(-Infinity)).toBe(0);
      expect(sanitizeTurnIndex('0')).toBe(0);
      expect(sanitizeTurnIndex('4')).toBe(4);
      expect(sanitizeTurnIndex('  7.8 ')).toBe(7);
      expect(sanitizeTurnIndex('-10')).toBe(0);
      expect(sanitizeTurnIndex('invalid-num')).toBe(0);
      expect(sanitizeTurnIndex('')).toBe(0);
      expect(sanitizeTurnIndex(null)).toBe(0);
      expect(sanitizeTurnIndex(undefined)).toBe(0);
      expect(sanitizeTurnIndex({})).toBe(0);
      expect(sanitizeTurnIndex([])).toBe(0);
    });

    it('Map 双账本模型与 activeTurnIndex 安全步进：多轮收口严格按权威快照对齐，0 伪增量注入', () => {
      const { env, state, callbacks } = makeEnv(SESS_ID);

      // Turn 0: delta 流式输入
      onMessageDelta(env, {
        kind: 'engine',
        type: 'message-delta',
        originalType: 'message-delta',
        event: {
          type: 'message-delta',
          sessionId: SESS_ID,
          timestamp: '',
          messageId: MSG_ID,
          block: { type: 'text', text: 'Turn 0 实时正文' },
        },
        raw: { turnIndex: 0 },
      });
      expect(state.activeTurnIndex).toBe(0);
      expect(state.turnStreamedTexts?.get(0)).toBe('Turn 0 实时正文');
      expect(callbacks.onChunk).toHaveBeenCalledWith('Turn 0 实时正文');

      // Turn 0: message-end 权威收口（修改终态标点）
      onMessageEnd(env, {
        kind: 'engine',
        type: 'message-end',
        originalType: 'message-end',
        event: {
          type: 'message-end',
          sessionId: SESS_ID,
          timestamp: '',
          turnIndex: 0,
          message: {
            id: MSG_ID,
            role: 'assistant',
            createdAt: '',
            content: 'Turn 0 权威正文。',
            blocks: [{ type: 'text', text: 'Turn 0 权威正文。' }],
          },
        },
        raw: {},
      });
      expect(state.turnAuthoritativeTexts?.get(0)).toBe('Turn 0 权威正文。');
      expect(state.assistantText).toBe('Turn 0 权威正文。');
      // onChunk 仍为 1 次，message-end 0 注入
      expect(callbacks.onChunk).toHaveBeenCalledTimes(1);

      // Turn 1: 浮点数 turnIndex: 1.8 -> 安全步进为 1
      onMessageDelta(env, {
        kind: 'engine',
        type: 'message-delta',
        originalType: 'message-delta',
        event: {
          type: 'message-delta',
          sessionId: SESS_ID,
          timestamp: '',
          messageId: MSG_ID,
          block: { type: 'text', text: 'Turn 1 实时正文' },
        },
        raw: { turnIndex: 1.8 },
      });
      expect(state.activeTurnIndex).toBe(1);
      expect(state.turnStreamedTexts?.get(1)).toBe('Turn 1 实时正文');
      expect(callbacks.onChunk).toHaveBeenCalledWith('Turn 1 实时正文');

      // Turn 1: message-end 收口（NaN 容错应由上游提供，若为 1 则收口 Turn 1）
      onMessageEnd(env, {
        kind: 'engine',
        type: 'message-end',
        originalType: 'message-end',
        event: {
          type: 'message-end',
          sessionId: SESS_ID,
          timestamp: '',
          turnIndex: 1,
          message: {
            id: MSG_ID,
            role: 'assistant',
            createdAt: '',
            content: 'Turn 1 权威正文。',
            blocks: [{ type: 'text', text: 'Turn 1 权威正文。' }],
          },
        },
        raw: {},
      });
      expect(state.turnAuthoritativeTexts?.get(1)).toBe('Turn 1 权威正文。');
      expect(state.assistantText).toBe('Turn 0 权威正文。\n\nTurn 1 权威正文。');
      expect(callbacks.onChunk).toHaveBeenCalledTimes(2);
    });
  });
});

