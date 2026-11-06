/**
 * 正文分段记账 · 时序回归套件（F1，sess-1793884211510 事故夹具）。
 *
 * 事故真值形态（O1 取证）：一轮内 5 段正文 × 41 工具交错，引擎 events
 * 顺序完好，但完成收口后落盘形态变成 [思考×1][工具×41][正文整段拼尾]，
 * 且第 2 轮首段正文整段丢失、多段思考只剩最后一段。
 *
 * 本套件以事故同型夹具钉住三态顺序一致：
 *  1. 流式中（store actions 增量写入）；
 *  2. 完成收口后（updateMessageTimeline / normalizeAssistantTimeline）；
 *  3. hydrate 重读后（projectEventsToMessages 事件投影 + parseSessionMessage）。
 * 并覆盖：退化 turnIndex（恒 0）下凭引擎消息 id 分段、子代理回调与面板
 * 投影两条旁路、孤儿块原位回插、思考重水合定位、第 2 轮型首段丢失负例。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { listSessions, replaceSessions } from '../sessionIndex';
import { useSessionStore } from '../sessionStore';
import type {
  MessageTimelineBlock,
  MessageToolCall,
  SessionMessage,
  SessionState,
} from '../types';
import {
  buildAssistantTimeline,
  normalizeAssistantTimeline,
  reconcileAssistantMessageBlocks,
  sliceActiveStreamText,
} from '../../api/tool-presentation/timelineNormalizer';
import { parseSessionMessage } from '../../api/session-persistence/sessionHydrationMessages';
import { projectEventsToMessages } from '../../api/sessionEventProjection';
import { applySubagentEventToMessages } from '../../api/subagentTimeline';
import { buildAgentStreamCallbacks } from '../../hooks/agentStreamCallbacks';

const SESS_ID = 'sess-segment-ordering';
const MSG_ID = 'asst-segment-ordering';

function makeToolCall(
  partial: Partial<MessageToolCall> &
    Pick<MessageToolCall, 'id' | 'name' | 'status'>
): MessageToolCall {
  return { arguments: '{}', ...partial };
}

function seedSession(msgs: SessionMessage[]) {
  const session = {
    id: SESS_ID,
    title: '分段时序回归会话',
    folder: '常规会话',
    isPinned: false,
    isArchived: false,
    timestamp: new Date().toISOString(),
    messages: msgs,
  } as unknown as SessionState;
  useSessionStore.setState((st) => {
    const rest = listSessions(st).filter((s) => s.id !== SESS_ID);
    replaceSessions(st, [...rest, session]);
  });
}

function getMsg(): SessionMessage | undefined {
  return useSessionStore
    .getState()
    .sessionsById[SESS_ID]?.messages.find((m) => m.id === MSG_ID);
}

function blockTypes(msg: SessionMessage | undefined): string[] {
  return (msg?.blocks ?? []).map((b) => b.type);
}

function textContents(msg: SessionMessage | undefined): string[] {
  return (msg?.blocks ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.content || '');
}

function thoughtContents(msg: SessionMessage | undefined): string[] {
  return (msg?.blocks ?? [])
    .filter((b) => b.type === 'thought')
    .map((b) => b.content || '');
}

/** 事故同型事件序列：turnIndex 恒 0（退化），段身份只在引擎消息 id 上。 */
function accidentEvents() {
  const end = (
    sequence: number,
    engineId: string,
    thought: string | null,
    text: string
  ) => ({
    sequence,
    type: 'runtime-event',
    payload: {
      event: {
        type: 'message-end',
        timestamp: sequence * 1000,
        turnIndex: 0,
        message: {
          role: 'assistant',
          id: engineId,
          clientMessageId: 'asst-accident',
          blocks: [
            ...(thought ? [{ type: 'thought', text: thought }] : []),
            { type: 'text', text },
          ],
        },
      },
    },
  });
  const toolStart = (sequence: number, id: string) => ({
    sequence,
    type: 'runtime-event',
    payload: {
      event: {
        type: 'tool-start',
        call: { id, name: 'read_file', args: '{}' },
        turnIndex: 0,
      },
    },
  });
  return [
    end(1, 'eng-msg-a', '思考A：先看结构', '正文一：先看结构。'),
    toolStart(2, 'call-1'),
    toolStart(3, 'call-2'),
    end(4, 'eng-msg-b', '思考B：再读实现', '正文二：再读实现。'),
    toolStart(5, 'call-3'),
    end(6, 'eng-msg-c', null, '总结：结论如下。'),
  ];
}

const ACCIDENT_BLOCK_TYPES = [
  'thought',
  'text',
  'tool_call',
  'tool_call',
  'thought',
  'text',
  'tool_call',
  'text',
];
const ACCIDENT_TEXTS = ['正文一：先看结构。', '正文二：再读实现。', '总结：结论如下。'];

describe('正文分段记账 · 时序回归（事故夹具）', () => {
  beforeEach(() => {
    seedSession([]);
  });

  it('hydrate 投影：退化 turnIndex 下凭引擎消息 id 分段，交错顺序与多段思考零丢失', () => {
    const { messages } = projectEventsToMessages(accidentEvents());
    expect(messages).toHaveLength(1);
    const asst = messages[0]!;

    expect(blockTypes(asst)).toEqual(ACCIDENT_BLOCK_TYPES);
    expect(textContents(asst)).toEqual(ACCIDENT_TEXTS);
    // 事故形态是思考只剩最后一段；两段思考必须都在
    expect(thoughtContents(asst)).toEqual(['思考A：先看结构', '思考B：再读实现']);
    expect(asst.text).toBe(ACCIDENT_TEXTS.join('\n\n'));
    // 正文段带稳定 id（分段记账身份），互不相同
    const textIds = (asst.blocks ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.id);
    expect(textIds.every((id) => typeof id === 'string' && id.startsWith('text-seg-'))).toBe(true);
    expect(new Set(textIds).size).toBe(textIds.length);
  });

  it('三态一致：投影 → 完成归一 → hydrate 重读，顺序与内容不变', () => {
    const { messages } = projectEventsToMessages(accidentEvents());
    const asst = messages[0]!;

    // 完成归一态：normalize 幂等，不重排、不拼尾
    const normalized = normalizeAssistantTimeline(asst);
    expect(blockTypes(normalized)).toEqual(ACCIDENT_BLOCK_TYPES);
    expect(textContents(normalized)).toEqual(ACCIDENT_TEXTS);
    const normalized2 = normalizeAssistantTimeline(normalized);
    expect(blockTypes(normalized2)).toEqual(ACCIDENT_BLOCK_TYPES);
    expect(textContents(normalized2)).toEqual(ACCIDENT_TEXTS);

    // hydrate 重读态：落盘 JSON 经 parse 再归一，形态不变
    const revived = parseSessionMessage(
      JSON.parse(JSON.stringify(normalized)) as Record<string, unknown>
    );
    expect(revived).toBeTruthy();
    const revivedNormalized = normalizeAssistantTimeline(revived!);
    expect(blockTypes(revivedNormalized)).toEqual(ACCIDENT_BLOCK_TYPES);
    expect(textContents(revivedNormalized)).toEqual(ACCIDENT_TEXTS);
    expect(thoughtContents(revivedNormalized)).toEqual([
      '思考A：先看结构',
      '思考B：再读实现',
    ]);
  });

  it('流式态：store 增量写入按事件序建段，收口归一后形态不变', () => {
    seedSession([
      {
        id: MSG_ID,
        sender: 'assistant',
        text: '',
        timestamp: Date.now(),
        status: 'processing',
        toolCalls: [],
        blocks: [],
      },
    ]);
    const store = useSessionStore.getState();

    store.updateMessageThinking(SESS_ID, MSG_ID, '思考A：先看结构', 0);
    store.updateMessageText(SESS_ID, MSG_ID, '正文一：');
    store.updateMessageText(SESS_ID, MSG_ID, '正文一：先看结构。');
    store.addMessageToolCall(
      SESS_ID,
      MSG_ID,
      makeToolCall({ id: 'call-1', name: 'read_file', status: 'running' })
    );
    store.addMessageToolCall(
      SESS_ID,
      MSG_ID,
      makeToolCall({ id: 'call-2', name: 'read_file', status: 'running' })
    );
    store.updateMessageThinking(SESS_ID, MSG_ID, '思考B：再读实现', 1);
    // 流式缓冲为原始拼接（无段间分隔符），新段必须靠界标而非偏移切分
    store.updateMessageText(SESS_ID, MSG_ID, '正文一：先看结构。正文二：再读实现。');
    store.addMessageToolCall(
      SESS_ID,
      MSG_ID,
      makeToolCall({ id: 'call-3', name: 'read_file', status: 'running' })
    );
    store.updateMessageText(
      SESS_ID,
      MSG_ID,
      '正文一：先看结构。正文二：再读实现。总结：结论如下。'
    );

    const live = getMsg();
    expect(blockTypes(live)).toEqual(ACCIDENT_BLOCK_TYPES);
    expect(textContents(live)).toEqual(ACCIDENT_TEXTS);

    // 完成收口（权威全文 = 各段以 \n\n 连接，与流式原始拼接不同形态）：
    // 锚点重对齐换成权威版，段界与顺序不动
    store.updateMessageText(SESS_ID, MSG_ID, ACCIDENT_TEXTS.join('\n\n'));
    store.updateMessageTimeline(SESS_ID, MSG_ID);
    const done = getMsg();
    expect(blockTypes(done)).toEqual(ACCIDENT_BLOCK_TYPES);
    expect(textContents(done)).toEqual(ACCIDENT_TEXTS);
    expect(thoughtContents(done)).toEqual(['思考A：先看结构', '思考B：再读实现']);
    // 收口幂等
    store.updateMessageTimeline(SESS_ID, MSG_ID);
    expect(blockTypes(getMsg())).toEqual(ACCIDENT_BLOCK_TYPES);
    expect(textContents(getMsg())).toEqual(ACCIDENT_TEXTS);
  });

  it('第 2 轮负例：无工具间隔的相邻 message-end，首段正文不丢失、不被覆盖', () => {
    const events = [
      {
        sequence: 1,
        type: 'runtime-event',
        payload: {
          event: {
            type: 'message-end',
            timestamp: 1000,
            turnIndex: 0,
            message: {
              role: 'assistant',
              id: 'eng-r2-a',
              clientMessageId: 'asst-r2',
              blocks: [{ type: 'text', text: '首段正文' }],
            },
          },
        },
      },
      {
        sequence: 2,
        type: 'runtime-event',
        payload: {
          event: {
            type: 'message-end',
            timestamp: 2000,
            turnIndex: 0,
            message: {
              role: 'assistant',
              id: 'eng-r2-b',
              clientMessageId: 'asst-r2',
              blocks: [{ type: 'text', text: '尾段正文' }],
            },
          },
        },
      },
    ];
    const { messages } = projectEventsToMessages(events);
    expect(messages).toHaveLength(1);
    expect(textContents(messages[0])).toEqual(['首段正文', '尾段正文']);
    expect(messages[0]?.text).toBe('首段正文\n\n尾段正文');
  });

  it('子代理回调路径：onChunk 累计快照同步建段（不再只写 text）', () => {
    const local: SessionMessage = {
      id: 'agent-asst-1',
      sender: 'assistant',
      text: '',
      timestamp: Date.now(),
      status: 'processing',
      toolCalls: [],
      blocks: [],
    };
    const callbacks = buildAgentStreamCallbacks('agent-asst-1', undefined, {
      parentSessionId: SESS_ID,
      agentId: 'agent-1',
      capturedEpoch: 0,
      getEpoch: () => 0,
      guard: () => true,
      buildPatchAsst: () => (fn) => fn(local),
      setLocalRunId: () => {},
      getLocalRunId: () => null,
      setCancel: () => {},
      patchSessionAgent: () => {},
    });

    callbacks.onThought?.('思考A', 0, 'set');
    callbacks.onChunk?.('正文一');
    callbacks.onToolStart?.('tc-1', 'read_file', '{}');
    callbacks.onThought?.('思考B', 1, 'set');
    callbacks.onChunk?.('正文一正文二');
    callbacks.onToolStart?.('tc-2', 'read_file', '{}');
    callbacks.onChunk?.('正文一正文二总结');

    expect(blockTypes(local)).toEqual([
      'thought',
      'text',
      'tool_call',
      'thought',
      'text',
      'tool_call',
      'text',
    ]);
    expect(textContents(local)).toEqual(['正文一', '正文二', '总结']);
    // 多轮思考各占一块（旧实现恒塌缩进 thought-turn-0 并互相覆盖）
    expect(thoughtContents(local)).toEqual(['思考A', '思考B']);
    expect(local.text).toBe('正文一正文二总结');
  });

  it('面板投影路径：delta 与 message-end 都建正文段', () => {
    let messages: SessionMessage[] = [];
    messages = applySubagentEventToMessages(messages, {
      type: 'message-delta',
      block: { type: 'text', text: '正文一' },
    });
    messages = applySubagentEventToMessages(messages, {
      type: 'tool-start',
      call: { id: 't1', name: 'read_file', input: {} },
    });
    messages = applySubagentEventToMessages(messages, {
      type: 'message-delta',
      block: { type: 'text', text: '正文二' },
    });
    messages = applySubagentEventToMessages(messages, {
      type: 'tool-start',
      call: { id: 't2', name: 'read_file', input: {} },
    });
    messages = applySubagentEventToMessages(messages, {
      type: 'message-end',
      message: { role: 'assistant', content: '总结段' },
    });

    const asst = messages.find((m) => m.sender === 'assistant');
    expect(blockTypes(asst)).toEqual([
      'text',
      'tool_call',
      'text',
      'tool_call',
      'text',
    ]);
    expect(textContents(asst)).toEqual(['正文一', '正文二', '总结段']);
    expect(asst?.text).toBe('正文一\n\n正文二\n\n总结段');
  });

  it('reconcile 孤儿回插：incoming 缺失的中间正文段回到原位（不沉底）', () => {
    const existing: MessageTimelineBlock[] = [
      { type: 'text', id: 'text-seg-0', content: '正文一', turnIndex: 0 },
      { type: 'tool_call', id: 'tc-1', turnIndex: 0 },
      { type: 'text', id: 'text-seg-1', content: '正文二', turnIndex: 0 },
      { type: 'tool_call', id: 'tc-2', turnIndex: 0 },
    ];
    const incoming: MessageTimelineBlock[] = [
      { type: 'text', id: 'text-seg-0', content: '正文一（更新）', turnIndex: 0 },
      { type: 'tool_call', id: 'tc-1', turnIndex: 0 },
      { type: 'tool_call', id: 'tc-2', turnIndex: 0 },
    ];
    const merged = reconcileAssistantMessageBlocks(existing, incoming);
    expect(merged.map((b) => b.type)).toEqual([
      'text',
      'tool_call',
      'text',
      'tool_call',
    ]);
    expect(merged[2]?.content).toBe('正文二');
  });

  it('思考重水合定位：缺失的中间轮思考插回其轮次位置（不追加末尾）', () => {
    const msg: SessionMessage = {
      id: 'm-rehydrate',
      sender: 'assistant',
      text: '正文二',
      timestamp: Date.now(),
      status: 'completed',
      toolCalls: [makeToolCall({ id: 'tc-x', name: 'bash', status: 'success' })],
      thinkingTurns: [
        { turnIndex: 0, content: '思考零', id: 'thought-turn-0' },
        { turnIndex: 1, content: '思考一', id: 'thought-turn-1' },
        { turnIndex: 2, content: '思考二', id: 'thought-turn-2' },
      ],
      blocks: [
        { type: 'thought', id: 'thought-turn-0', content: '思考零', turnIndex: 0 },
        { type: 'tool_call', id: 'tc-x' },
        { type: 'text', id: 'text-seg-0', content: '正文二', turnIndex: 2 },
      ],
    };
    const normalized = normalizeAssistantTimeline(msg);
    expect(thoughtContents(normalized)).toEqual(['思考零', '思考一', '思考二']);
    const types = blockTypes(normalized);
    // 思考二必须紧邻其同轮正文之前，思考一不得沉到正文之后
    const textIdx = types.indexOf('text');
    expect(types[textIdx - 1]).toBe('thought');
    expect(normalized.blocks?.[textIdx - 1]?.content).toBe('思考二');
    expect(types.indexOf('text')).toBeLessThan(types.length);
    expect(thoughtContents(normalized).indexOf('思考一')).toBeLessThan(2 + 1);
    expect(
      normalized.blocks?.findIndex(
        (b) => b.type === 'thought' && b.content === '思考一'
      )
    ).toBeLessThan(textIdx);
  });

  it('无账本兜底边界：正文存在但全无 text 块时只补单段于末尾（不虚构分段）', () => {
    const msg: SessionMessage = {
      id: 'm-noblocks',
      sender: 'assistant',
      text: '整段正文',
      timestamp: Date.now(),
      status: 'completed',
      toolCalls: [makeToolCall({ id: 'tc-y', name: 'bash', status: 'success' })],
      blocks: [],
    };
    const normalized = normalizeAssistantTimeline(msg);
    const texts = (normalized.blocks ?? []).filter((b) => b.type === 'text');
    expect(texts).toHaveLength(1);
    expect(texts[0]?.content).toBe('整段正文');
    expect(normalized.blocks?.[normalized.blocks.length - 1]?.type).toBe('text');
    // 渲染层同口径：tools 一组 + 全文单段
    const timeline = buildAssistantTimeline(normalized);
    expect(timeline.map((t) => t.kind)).toEqual(['tools', 'text']);
  });

  it('sliceActiveStreamText：剥离已封口段后只剩活跃段（含未落块增量）', () => {
    const blocks: MessageTimelineBlock[] = [
      { type: 'text', id: 'text-seg-0', content: '正文一', turnIndex: 0 },
      { type: 'tool_call', id: 'tc-1' },
      { type: 'text', id: 'text-seg-1', content: '正文二', turnIndex: 0 },
    ];
    expect(sliceActiveStreamText('正文一正文二增量', blocks)).toBe('正文二增量');
    // 无界标（无已封口段）时原样返回
    expect(sliceActiveStreamText('全量正文', [blocks[0]!])).toBe('全量正文');
    expect(sliceActiveStreamText('', blocks)).toBe('');
  });
});
