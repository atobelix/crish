import { describe, expect, it, vi } from 'vitest';
import type { SessionMessage } from '../store/layoutStore';
import {
  extractEngineSequence,
  extractMessageTimestamp,
  isContextStateBogusUserMessage,
  mergeMessagesById,
  projectEventsToMessages,
} from './sessionEventProjection';

type SessionMessageWithSeq = SessionMessage & { engineSequence?: number };

describe('sessionEventTimestamp: extractMessageTimestamp 与 extractEngineSequence', () => {
  it('message-end 缺顶层 timestamp 时，权威提取 inner.message.createdAt（ISO 8601 → 毫秒）', () => {
    const iso = '2026-10-12T01:00:00.000Z';
    const inner = {
      type: 'message-end',
      message: {
        id: 'u1',
        role: 'user',
        createdAt: iso,
        blocks: [{ type: 'text', text: 'hello' }],
      },
    };
    expect(extractMessageTimestamp(inner, 'message-end')).toBe(Date.parse(iso));
  });

  it('inner.message.createdAt 优先级高于 inner.timestamp，绝不被外层 timestamp 覆盖', () => {
    const authoritativeIso = '2026-10-12T01:00:00.000Z';
    const inner = {
      type: 'message-end',
      timestamp: '2026-10-12T09:59:59.000Z',
      message: {
        id: 'a1',
        role: 'assistant',
        createdAt: authoritativeIso,
      },
    };
    expect(extractMessageTimestamp(inner, 'message-end')).toBe(
      Date.parse(authoritativeIso)
    );
  });

  it('inner.message.createdAt 缺省时，回退读取 inner.timestamp（支持数字与 ISO 字符串）', () => {
    const innerNum = {
      type: 'message-end',
      timestamp: 1700000001234,
      message: { role: 'user', content: 'hi' },
    };
    expect(extractMessageTimestamp(innerNum, 'message-end')).toBe(
      1700000001234
    );

    const innerIso = {
      type: 'message-delta',
      timestamp: '2026-10-12T02:00:00.000Z',
      block: { type: 'text', text: 'chunk' },
    };
    expect(extractMessageTimestamp(innerIso, 'message-delta')).toBe(
      Date.parse('2026-10-12T02:00:00.000Z')
    );
  });

  it('历史终态事件（message-end / message-start）无任何时间戳时返回 0，严禁调用 Date.now() 污染历史', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1999999999999);
    try {
      const endTs = extractMessageTimestamp(
        {
          type: 'message-end',
          message: { role: 'user', content: 'no timestamp' },
        },
        'message-end'
      );
      const startTs = extractMessageTimestamp(
        {
          type: 'message-start',
          message: { role: 'assistant' },
        },
        'message-start'
      );
      expect(endTs).toBe(0);
      expect(startTs).toBe(0);
      expect(nowSpy).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('非历史终态事件（如实时 message-delta / tool-start）无时间戳时回退当前时间', () => {
    const fakeNow = 1788888888888;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(fakeNow);
    try {
      const deltaTs = extractMessageTimestamp(
        { type: 'message-delta', block: { type: 'text', text: 'x' } },
        'message-delta'
      );
      expect(deltaTs).toBe(fakeNow);
      expect(nowSpy).toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('extractEngineSequence 从外层信封、payload.event 或内层事件提取真实 sequence，拒绝非法值', () => {
    expect(extractEngineSequence({ sequence: 42 })).toBe(42);
    expect(
      extractEngineSequence(
        { type: 'message-end' },
        { sequence: 7, type: 'runtime-event' }
      )
    ).toBe(7);
    expect(
      extractEngineSequence({
        type: 'runtime-event',
        payload: { sequence: 15, event: { type: 'message-end' } },
      })
    ).toBe(15);
    expect(extractEngineSequence({ sequence: -1 })).toBeUndefined();
    expect(extractEngineSequence({ sequence: Number.NaN })).toBeUndefined();
    expect(extractEngineSequence({})).toBeUndefined();
    expect(extractEngineSequence(null)).toBeUndefined();
  });
});

describe('sessionEventProjection: 真实 createdAt 与 engineSequence 透传及因果保序', () => {
  it('message-end 缺顶层 timestamp 时，必须从 message.createdAt 解析并透传 engineSequence', () => {
    const userCreatedAt = '2026-10-12T01:00:00.000Z';
    const asstCreatedAt = '2026-10-12T01:00:05.000Z';

    const events = [
      {
        type: 'message-end',
        sequence: 1,
        message: {
          id: 'user-msg-1',
          role: 'user',
          createdAt: userCreatedAt,
          blocks: [{ type: 'text', text: '你好' }],
        },
      },
      {
        type: 'message-end',
        sequence: 2,
        message: {
          id: 'assistant-msg-1',
          role: 'assistant',
          createdAt: asstCreatedAt,
          blocks: [{ type: 'text', text: '你好！有什么我可以帮你的？' }],
        },
      },
    ];

    const { messages, maxSequence } = projectEventsToMessages(events);
    expect(messages).toHaveLength(2);
    expect(maxSequence).toBe(2);

    const u = messages[0] as SessionMessageWithSeq;
    const a = messages[1] as SessionMessageWithSeq;

    expect(u.sender).toBe('user');
    expect(u.id).toBe('user-msg-1');
    expect(u.timestamp).toBe(Date.parse(userCreatedAt));
    expect(u.engineSequence).toBe(1);

    expect(a.sender).toBe('assistant');
    expect(a.id).toBe('assistant-msg-1');
    expect(a.timestamp).toBe(Date.parse(asstCreatedAt));
    expect(a.engineSequence).toBe(2);
  });

  it('多轮对话事件流投影后，顺序严格保持 U1 -> A1 -> U2 -> A2 且携带递增时间戳与序列号', () => {
    const mkMessageEnd = (
      id: string,
      role: 'user' | 'assistant',
      createdAt: string,
      sequence: number
    ) => ({
      sequence,
      type: 'runtime-event',
      payload: {
        event: {
          type: 'message-end',
          message: {
            id,
            role,
            createdAt,
            blocks: [{ type: 'text', text: `${role}:${id}` }],
          },
        },
      },
    });

    const events = [
      mkMessageEnd('user-msg-001', 'user', '2026-10-12T01:00:00.000Z', 10),
      mkMessageEnd(
        'assistant-msg-001',
        'assistant',
        '2026-10-12T01:00:05.000Z',
        20
      ),
      mkMessageEnd('user-msg-002', 'user', '2026-10-12T01:01:00.000Z', 30),
      mkMessageEnd(
        'assistant-msg-002',
        'assistant',
        '2026-10-12T01:01:08.000Z',
        40
      ),
    ];

    const { messages, maxSequence } = projectEventsToMessages(events);
    expect(maxSequence).toBe(40);
    expect(messages.map((m) => m.id)).toEqual([
      'user-msg-001',
      'assistant-msg-001',
      'user-msg-002',
      'assistant-msg-002',
    ]);
    expect(messages.map((m) => m.sender)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(
      messages.map((m) => (m as SessionMessageWithSeq).engineSequence)
    ).toEqual([10, 20, 30, 40]);

    // 再经 mergeMessagesById 合并也绝不因 'assistant-msg-*' < 'user-msg-*' 字典序而颠倒
    const merged = mergeMessagesById([], messages);
    expect(merged.map((m) => m.id)).toEqual([
      'user-msg-001',
      'assistant-msg-001',
      'user-msg-002',
      'assistant-msg-002',
    ]);
  });

  it('message-delta 先行、message-end 后达时，以 message-end 的真实 createdAt 与 sequence 权威纠偏', () => {
    const deltaIso = '2026-10-12T01:00:01.000Z';
    const endIso = '2026-10-12T01:00:03.500Z';
    const events = [
      {
        sequence: 5,
        type: 'runtime-event',
        payload: {
          event: {
            type: 'message-delta',
            timestamp: deltaIso,
            block: { type: 'text', text: '部分流式' },
          },
        },
      },
      {
        sequence: 6,
        type: 'runtime-event',
        payload: {
          event: {
            type: 'message-end',
            message: {
              id: 'engine-asst-6',
              clientMessageId: 'assistant-msg-stable-6',
              role: 'assistant',
              createdAt: endIso,
              blocks: [{ type: 'text', text: '完整终态回复' }],
            },
          },
        },
      },
    ];

    const { messages } = projectEventsToMessages(events);
    expect(messages).toHaveLength(1);
    const asst = messages[0] as SessionMessageWithSeq;
    expect(asst.id).toBe('assistant-msg-stable-6');
    expect(asst.text).toBe('完整终态回复');
    expect(asst.timestamp).toBe(Date.parse(endIso));
    expect(asst.engineSequence).toBe(6);
  });

  it('兼容简写 { sequence, event: { type: "message-end", message: { content: [...] } } } 信封结构', () => {
    const mockEvents = [
      {
        sequence: 10,
        event: {
          type: 'message-end',
          message: {
            role: 'user',
            content: [{ type: 'text', text: '你好' }],
            createdAt: '2026-03-01T10:00:00.000Z',
          },
        },
      },
      {
        sequence: 11,
        event: {
          type: 'message-end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '你好！很高兴为你服务。' }],
            createdAt: '2026-03-01T10:00:05.000Z',
          },
        },
      },
    ];

    const result = projectEventsToMessages(mockEvents);
    expect(result.messages).toHaveLength(2);
    const u = result.messages[0] as SessionMessageWithSeq;
    const a = result.messages[1] as SessionMessageWithSeq;
    expect(u.sender).toBe('user');
    expect(u.text).toBe('你好');
    expect(u.timestamp).toBe(Date.parse('2026-03-01T10:00:00.000Z'));
    expect(u.engineSequence).toBe(10);

    expect(a.sender).toBe('assistant');
    expect(a.text).toBe('你好！很高兴为你服务。');
    expect(a.timestamp).toBe(Date.parse('2026-03-01T10:00:05.000Z'));
    expect(a.engineSequence).toBe(11);
  });

  it('RC-06: 连续多条 assistant 消息在遇到 turn-start 或不同 messageId 时不发生塌缩', () => {
    const events = [
      {
        sequence: 1,
        event: {
          type: 'turn-start',
          turnIndex: 0,
        },
      },
      {
        sequence: 2,
        event: {
          type: 'message-end',
          turnIndex: 0,
          message: {
            id: 'asst-msg-turn0',
            clientMessageId: 'asst-msg-turn0',
            role: 'assistant',
            content: [{ type: 'text', text: '这是第一轮的回答' }],
            createdAt: '2026-03-01T10:00:01.000Z',
          },
        },
      },
      {
        sequence: 3,
        event: {
          type: 'turn-start',
          turnIndex: 1,
        },
      },
      {
        sequence: 4,
        event: {
          type: 'message-end',
          turnIndex: 1,
          message: {
            id: 'asst-msg-turn1',
            clientMessageId: 'asst-msg-turn1',
            role: 'assistant',
            content: [{ type: 'text', text: '这是第二轮自动续航的独立回答' }],
            createdAt: '2026-03-01T10:00:05.000Z',
          },
        },
      },
    ];

    const result = projectEventsToMessages(events);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.id).toBe('asst-msg-turn0');
    expect(result.messages[0]!.text).toBe('这是第一轮的回答');
    expect(result.messages[1]!.id).toBe('asst-msg-turn1');
    expect(result.messages[1]!.text).toBe('这是第二轮自动续航的独立回答');
  });

  it('RC-06: 连续多条带不同非空 stableId 的 assistant message-end 事件即便无 turn-start 也不塌缩', () => {
    const events = [
      {
        sequence: 1,
        event: {
          type: 'message-end',
          message: {
            id: 'asst-1',
            clientMessageId: 'asst-1',
            role: 'assistant',
            content: [{ type: 'text', text: '回答一' }],
            createdAt: '2026-03-01T10:00:01.000Z',
          },
        },
      },
      {
        sequence: 2,
        event: {
          type: 'message-end',
          message: {
            id: 'asst-2',
            clientMessageId: 'asst-2',
            role: 'assistant',
            content: [{ type: 'text', text: '回答二' }],
            createdAt: '2026-03-01T10:00:02.000Z',
          },
        },
      },
    ];

    const result = projectEventsToMessages(events);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.id).toBe('asst-1');
    expect(result.messages[0]!.text).toBe('回答一');
    expect(result.messages[1]!.id).toBe('asst-2');
    expect(result.messages[1]!.text).toBe('回答二');
  });

  it('RC-06: 允许无文本但含 attachments/images 的 user 消息通过 pushUser', () => {
    const events = [
      {
        sequence: 1,
        event: {
          type: 'message-end',
          message: {
            id: 'user-img-msg',
            role: 'user',
            attachments: [{ id: 'att-1', name: 'screenshot.png' }],
            content: [],
            createdAt: '2026-03-01T10:00:00.000Z',
          },
        },
      },
    ];

    const result = projectEventsToMessages(events);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.id).toBe('user-img-msg');
    expect(result.messages[0]!.sender).toBe('user');
    expect(result.messages[0]!.attachments).toEqual([
      { id: 'att-1', name: 'screenshot.png' },
    ]);
  });

  it('RC-06: 支持 message-start 事件投影', () => {
    const events = [
      {
        sequence: 1,
        event: {
          type: 'message-start',
          message: {
            id: 'user-start-1',
            role: 'user',
            content: [{ type: 'text', text: '提问开始' }],
            createdAt: '2026-03-01T10:00:00.000Z',
          },
        },
      },
      {
        sequence: 2,
        event: {
          type: 'message-start',
          message: {
            id: 'asst-start-1',
            role: 'assistant',
            createdAt: '2026-03-01T10:00:01.000Z',
          },
        },
      },
      {
        sequence: 3,
        event: {
          type: 'message-delta',
          block: { type: 'text', text: '助手流式正文' },
        },
      },
    ];

    const result = projectEventsToMessages(events);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.id).toBe('user-start-1');
    expect(result.messages[0]!.text).toBe('提问开始');
    expect(result.messages[1]!.id).toBe('asst-start-1');
    expect(result.messages[1]!.text).toBe('助手流式正文');
  });

  it('RC-05: 无时间戳历史事件回放时，delta 与 terminal 均 fallback 到 0，避免 user=0 而 asst=Date.now()', () => {
    const events = [
      {
        sequence: 1,
        event: {
          type: 'message-end',
          message: {
            id: 'user-no-ts',
            role: 'user',
            content: [{ type: 'text', text: '用户问题' }],
          },
        },
      },
      {
        sequence: 2,
        event: {
          type: 'message-delta',
          block: { type: 'text', text: '助手回答' },
        },
      },
      {
        sequence: 3,
        event: {
          type: 'message-end',
          message: {
            id: 'asst-no-ts',
            role: 'assistant',
            content: [{ type: 'text', text: '助手回答' }],
          },
        },
      },
    ];

    const result = projectEventsToMessages(events);
    expect(result.messages).toHaveLength(2);
    // User 与 Assistant 在历史无时间戳事件投影下时间戳均为 0，绝不因 Date.now() 倒置因果
    expect(result.messages[0]!.timestamp).toBe(0);
    expect(result.messages[1]!.timestamp).toBe(0);
    expect(result.messages[0]!.sender).toBe('user');
    expect(result.messages[1]!.sender).toBe('assistant');
  });

  describe('context-state 事件拦截与投影防腐', () => {
    it('传入 role: user 且 metadata: { kind: "context-state" } 的 message-start 事件，断言投影结果中绝不产生 sender: "user" 消息', () => {
      const events = [
        {
          sequence: 1,
          event: {
            type: 'message-start',
            message: {
              id: 'context-state-msg-1',
              role: 'user',
              metadata: { kind: 'context-state' },
              content: [
                {
                  type: 'text',
                  text: '当前已切换到模型 ornith:latest（服务商 ollama）。权限模式：full。思考档位：Max。',
                },
              ],
              createdAt: '2026-10-12T01:00:00.000Z',
            },
          },
        },
      ];

      const result = projectEventsToMessages(events);
      // 投影结果必须为空，绝不产生 sender === 'user' 的独立用户气泡
      expect(result.messages).toHaveLength(0);
      expect(result.messages.filter((m) => m.sender === 'user')).toHaveLength(
        0
      );
    });

    it('传入 role: user 且 metadata: { kind: "context-state" } 的 message-end 事件，断言投影结果中绝不产生用户气泡', () => {
      const events = [
        {
          sequence: 1,
          event: {
            type: 'message-end',
            message: {
              id: 'context-state-msg-end',
              role: 'user',
              metadata: { kind: 'context-state' },
              blocks: [
                {
                  type: 'text',
                  text: '当前已切换到模型 claude-3-5-sonnet。权限模式：default。',
                },
              ],
              createdAt: '2026-10-12T01:00:00.000Z',
            },
          },
        },
      ];

      const result = projectEventsToMessages(events);
      expect(result.messages).toHaveLength(0);
    });

    it('传入无 client_message_id 且正文匹配 /^当前已切换到模型/ 的裸消息事件，断言被防腐拦截', () => {
      const events = [
        {
          sequence: 1,
          type: 'runtime-event',
          payload: {
            event: {
              type: 'message-start',
              message: {
                id: 'stale-naked-msg',
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: '当前已切换到模型 deepseek-chat（服务商 deepseek）。权限模式：full。思考档位：Max。',
                  },
                ],
                createdAt: '2026-10-12T01:00:00.000Z',
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
              message: {
                id: 'stale-naked-msg',
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: '当前已切换到模型 deepseek-chat（服务商 deepseek）。权限模式：full。思考档位：Max。',
                  },
                ],
                createdAt: '2026-10-12T01:00:00.000Z',
              },
            },
          },
        },
      ];

      const result = projectEventsToMessages(events);
      expect(result.messages).toHaveLength(0);
    });

    it('多轮对话混合场景中，context-state 伪消息被完全剔除，而正常用户提问与助手回复完整投影', () => {
      const events = [
        // 正常提问 1
        {
          sequence: 1,
          event: {
            type: 'message-end',
            message: {
              id: 'u1',
              client_message_id: 'c-u1',
              role: 'user',
              content: [{ type: 'text', text: '你好，帮我写个函数' }],
              createdAt: '2026-10-12T01:00:00.000Z',
            },
          },
        },
        // 助手回复 1
        {
          sequence: 2,
          event: {
            type: 'message-end',
            message: {
              id: 'a1',
              role: 'assistant',
              content: [{ type: 'text', text: '这是为您编写的函数' }],
              createdAt: '2026-10-12T01:00:05.000Z',
            },
          },
        },
        // 引擎旧 bug 触发的伪用户消息 (context-state)
        {
          sequence: 3,
          event: {
            type: 'message-start',
            message: {
              id: 'cs-u-fake',
              role: 'user',
              metadata: { kind: 'context-state' },
              content: [
                {
                  type: 'text',
                  text: '当前已切换到模型 ornith:latest。权限模式：full。思考档位：Max。',
                },
              ],
              createdAt: '2026-10-12T01:00:10.000Z',
            },
          },
        },
        // 正常提问 2（高内聚信封消息）
        {
          sequence: 4,
          event: {
            type: 'message-end',
            message: {
              id: 'u2',
              client_message_id: 'c-u2',
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: '[用户输入]\n请解释这段代码\n\n[系统环境上下文]\n当前已切换到模型 ornith:latest（服务商 ollama）。权限模式：full。思考档位：Max。',
                },
              ],
              createdAt: '2026-10-12T01:01:00.000Z',
            },
          },
        },
        // 助手回复 2
        {
          sequence: 5,
          event: {
            type: 'message-end',
            message: {
              id: 'a2',
              role: 'assistant',
              content: [{ type: 'text', text: '这段代码的作用是...' }],
              createdAt: '2026-10-12T01:01:10.000Z',
            },
          },
        },
      ];

      const result = projectEventsToMessages(events);
      // cs-u-fake 被彻底拦截，剩余 4 条合法消息
      expect(result.messages).toHaveLength(4);
      expect(result.messages.map((m) => m.id)).toEqual([
        'c-u1',
        'a1',
        'c-u2',
        'a2',
      ]);
      expect(result.messages.map((m) => m.sender)).toEqual([
        'user',
        'assistant',
        'user',
        'assistant',
      ]);
      expect(result.messages[2]!.text).toContain('[用户输入]');
    });

    it('isContextStateBogusUserMessage 纯函数边界判定契约测试', () => {
      // 1. null / undefined
      expect(isContextStateBogusUserMessage(null)).toBe(false);
      expect(isContextStateBogusUserMessage(undefined)).toBe(false);

      // 2. metadata.kind === 'context-state'
      expect(
        isContextStateBogusUserMessage({
          role: 'user',
          metadata: { kind: 'context-state' },
        } as any)
      ).toBe(true);

      // 3. 裸正文无 client_message_id 且以 当前已切换到模型 开头
      expect(
        isContextStateBogusUserMessage({
          role: 'user',
          blocks: [{ type: 'text', text: '当前已切换到模型 gpt-4o' }],
        } as any)
      ).toBe(true);

      // 4. 有 client_message_id 的普通用户提问中恰好包含该文本（不拦截）
      expect(
        isContextStateBogusUserMessage({
          role: 'user',
          clientMessageId: 'client-123',
          blocks: [{ type: 'text', text: '当前已切换到模型，但为什么报错？' }],
        } as any)
      ).toBe(false);

      // 5. 高内聚 [用户输入] 消息（不拦截）
      expect(
        isContextStateBogusUserMessage({
          role: 'user',
          blocks: [
            {
              type: 'text',
              text: '[用户输入]\n你好\n\n[系统环境上下文]\n当前已切换到模型 xxx',
            },
          ],
        } as any)
      ).toBe(false);
    });
  });
});
