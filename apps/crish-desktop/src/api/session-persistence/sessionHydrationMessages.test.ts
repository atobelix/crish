import { describe, expect, it } from 'vitest';
import {
  parseSessionMessage,
  parseSessionMessages,
  purgeStaleContextStateBubbles,
  sanitizeMessagesForHydrate,
} from './sessionHydrationMessages';
import type { SessionMessage } from '../../store/layoutStore';

describe('sessionHydrationMessages', () => {
  it('preserves engineSequence and parses valid message structure', () => {
    const raw = {
      id: 'msg-1',
      sender: 'user',
      timestamp: 1791764675738,
      engineSequence: 0,
      text: 'Hello world',
    };
    const parsed = parseSessionMessage(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe('msg-1');
    expect(parsed?.sender).toBe('user');
    expect(parsed?.timestamp).toBe(1791764675738);
    expect(parsed?.engineSequence).toBe(0);
    expect(parsed?.text).toBe('Hello world');
  });

  it('heals causal order for dirty legacy session (sess-1791764675736) where timestamps collided and IDs were inverted', () => {
    // In sess-1791764675736:
    // User sent message 1, AI replied message 2, User sent message 3, AI replied message 4.
    // Under old bug, all had identical timestamp and lexical ID sort put 'assistant-*' before 'user-*'.
    const dirtyMessages: SessionMessage[] = [
      {
        id: 'assistant-msg-1',
        sender: 'assistant',
        timestamp: 1791764675000,
        text: 'AI response 1',
      },
      {
        id: 'assistant-msg-2',
        sender: 'assistant',
        timestamp: 1791764675000,
        text: 'AI response 2',
      },
      {
        id: 'user-msg-1',
        sender: 'user',
        timestamp: 1791764675000,
        text: 'User query 1',
      },
      {
        id: 'user-msg-2',
        sender: 'user',
        timestamp: 1791764675000,
        text: 'User query 2',
      },
    ];

    const healed = sanitizeMessagesForHydrate(dirtyMessages);

    // Assert that User query 1 is first, AI response 1 follows, then User query 2, then AI response 2
    expect(healed.map((m) => m.sender)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(healed.map((m) => m.text)).toEqual([
      'User query 1',
      'AI response 1',
      'User query 2',
      'AI response 2',
    ]);
    // Monotonically increasing engineSequence assigned
    expect(healed[0]!.engineSequence).toBe(0);
    expect(healed[1]!.engineSequence).toBe(1);
    expect(healed[2]!.engineSequence).toBe(2);
    expect(healed[3]!.engineSequence).toBe(3);
  });

  it('sanitizes processing messages and unfinished tool calls on hydration', () => {
    const raw: SessionMessage[] = [
      {
        id: 'msg-proc',
        sender: 'assistant',
        timestamp: 1000,
        status: 'processing',
        text: 'Interrupted text',
        toolCalls: [
          {
            id: 'tc-1',
            name: 'bash',
            arguments: '{}',
            status: 'running',
          },
        ],
      },
    ];
    const sanitized = sanitizeMessagesForHydrate(raw);
    expect(sanitized[0]!.status).toBe('completed');
    expect(sanitized[0]!.toolCalls?.[0]?.status).toBe('error');
    expect(sanitized[0]!.toolCalls?.[0]?.output).toContain('上次会话中断');
  });

  it('RC-02: does NOT misjudge multi-turn session with random UUIDs and preserves causal order and timestamps', () => {
    // 3-turn conversation where UUIDs are non-monotonic and have digits
    const messages: SessionMessage[] = [
      {
        id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
        sender: 'user',
        timestamp: 1000,
        text: 'Question 1',
      },
      {
        id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        sender: 'assistant',
        timestamp: 2000,
        text: 'Answer 1',
      },
      {
        id: '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed',
        sender: 'user',
        timestamp: 3000,
        text: 'Question 2',
      },
      {
        id: 'a2c3d4e5-f6a7-4890-b1c2-d3e4f5a6b7c8',
        sender: 'assistant',
        timestamp: 4000,
        text: 'Answer 2',
      },
      {
        id: '0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d',
        sender: 'user',
        timestamp: 5000,
        text: 'Question 3',
      },
      {
        id: 'e8f9a0b1-c2d3-4e5f-6a7b-8c9d0e1f2a3b',
        sender: 'assistant',
        timestamp: 6000,
        text: 'Answer 3',
      },
    ];

    const result = sanitizeMessagesForHydrate(messages);

    // Causal order and question-answer pairings must remain completely intact!
    expect(result.map((m) => m.id)).toEqual([
      '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
      'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed',
      'a2c3d4e5-f6a7-4890-b1c2-d3e4f5a6b7c8',
      '0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d',
      'e8f9a0b1-c2d3-4e5f-6a7b-8c9d0e1f2a3b',
    ]);
    expect(result.map((m) => m.text)).toEqual([
      'Question 1',
      'Answer 1',
      'Question 2',
      'Answer 2',
      'Question 3',
      'Answer 3',
    ]);
    expect(result.map((m) => m.timestamp)).toEqual([
      1000, 2000, 3000, 4000, 5000, 6000,
    ]);
    expect(result.map((m) => m.engineSequence)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('RC-02: does NOT misjudge multi-assistant messages within a turn as corrupted causal group', () => {
    const messages: SessionMessage[] = [
      { id: 'u-1', sender: 'user', timestamp: 1000, text: 'Query 1' },
      {
        id: 'a-1-ctx',
        sender: 'assistant',
        timestamp: 2000,
        text: 'Context injection',
      },
      {
        id: 'a-1-ans',
        sender: 'assistant',
        timestamp: 2001,
        text: 'Final Answer',
      },
      { id: 'u-2', sender: 'user', timestamp: 3000, text: 'Query 2' },
      { id: 'a-2-ans', sender: 'assistant', timestamp: 4000, text: 'Answer 2' },
    ];
    const result = sanitizeMessagesForHydrate(messages);
    expect(result.map((m) => m.id)).toEqual([
      'u-1',
      'a-1-ctx',
      'a-1-ans',
      'u-2',
      'a-2-ans',
    ]);
    expect(result.map((m) => m.engineSequence)).toEqual([0, 1, 2, 3, 4]);
  });

  it('RC-03: parseSessionMessage preserves error status, image/step blocks, and top-level media fields', () => {
    const raw = {
      id: 'msg-err-1',
      sender: 'assistant',
      timestamp: 12345,
      status: 'error',
      engineSequence: 7,
      errorDetail: {
        message: 'Connection timeout',
        kind: 'network',
        technical: 'ECONNRESET',
      },
      injections: [{ id: 'inj-1', title: 'Rules', content: 'Agent rule' }],
      attachments: [{ id: 'att-1', name: 'log.txt', size: 1024 }],
      images: [{ id: 'img-1', url: 'https://example.com/pic.png' }],
      metadata: { runId: 'run-99' },
      blocks: [
        { type: 'text', content: 'Pre error text' },
        {
          type: 'image',
          images: [{ id: 'img-1', url: 'https://example.com/pic.png' }],
        },
        { type: 'step_start', content: 'Step 1' },
        { type: 'step_end', content: 'Step 1 done' },
      ],
    };

    const parsed = parseSessionMessage(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.status).toBe('error');
    expect(parsed?.engineSequence).toBe(7);
    expect(parsed?.errorDetail?.message).toBe('Connection timeout');
    expect(parsed?.errorDetail?.kind).toBe('network');
    expect(parsed?.injections?.[0]?.id).toBe('inj-1');
    expect(parsed?.attachments?.[0]?.name).toBe('log.txt');
    expect(parsed?.images?.[0]?.url).toBe('https://example.com/pic.png');
    expect(parsed?.metadata).toEqual({ runId: 'run-99' });
    expect(parsed?.blocks).toHaveLength(4);
    expect(parsed?.blocks?.[1]?.type).toBe('image');
    expect(parsed?.blocks?.[2]?.type).toBe('step_start');
    expect(parsed?.blocks?.[3]?.type).toBe('step_end');
  });

  it('RC-04: sessionRustDbWire roundtrips engineSequence', async () => {
    const { toRustSessionMessage, fromRustSessionMessage } =
      await import('./sessionRustDbWire');
    const jsMsg: SessionMessage = {
      id: 'msg-wire-1',
      sender: 'assistant',
      timestamp: 5000,
      engineSequence: 42,
      text: 'Wire test',
    };
    const rustWire = toRustSessionMessage(jsMsg);
    expect(rustWire.engineSequence).toBe(42);

    const restored = fromRustSessionMessage(rustWire);
    expect(restored).not.toBeNull();
    expect(restored?.id).toBe('msg-wire-1');
    expect(restored?.engineSequence).toBe(42);
  });

  it('RC-04: mergeSessionMessageFields preserves incoming engineSequence and metadata', async () => {
    const { mergeSessionMessageFields } =
      await import('../../store/sessionSharedHelpers.messageMerge');
    const existing: SessionMessage = {
      id: 'msg-merge-1',
      sender: 'assistant',
      timestamp: 1000,
      status: 'processing',
      text: 'Partial text',
    };
    const incoming: SessionMessage = {
      id: 'msg-merge-1',
      sender: 'assistant',
      timestamp: 1000,
      status: 'completed',
      text: 'Final text',
      engineSequence: 15,
      attachments: [{ id: 'att-x', name: 'data.csv' }],
      metadata: { traceId: 'tr-1' },
    };

    mergeSessionMessageFields(existing, incoming);
    expect(existing.status).toBe('completed');
    expect(existing.text).toBe('Final text');
    expect(existing.engineSequence).toBe(15);
    expect(existing.attachments?.[0]?.name).toBe('data.csv');
    expect(existing.metadata).toEqual({ traceId: 'tr-1' });
  });

  describe('purgeStaleContextStateBubbles: 历史脏数据自愈净化', () => {
    it('包含历史孤儿对（“当前已切换到模型...” + “明白了。当前配置...”）时，验证两者被精准修剪', () => {
      const messages: SessionMessage[] = [
        {
          id: 'msg-u1',
          sender: 'user',
          timestamp: 1000,
          text: '请帮我实现一个 LRU 缓存',
        },
        {
          id: 'msg-a1',
          sender: 'assistant',
          timestamp: 2000,
          text: '好的，这是 LRU 缓存的实现方案：...',
        },
        {
          id: 'msg-u-stale',
          sender: 'user',
          timestamp: 3000,
          text: '当前已切换到模型 ornith:latest（服务商 ollama）。权限模式：full。思考档位：Max。',
        },
        {
          id: 'msg-a-stale',
          sender: 'assistant',
          timestamp: 4000,
          text: '明白了。当前配置：模型已设置为 ornith:latest。',
        },
        {
          id: 'msg-u2',
          sender: 'user',
          timestamp: 5000,
          text: '请为这个 LRU 补充单元测试',
        },
        {
          id: 'msg-a2',
          sender: 'assistant',
          timestamp: 6000,
          text: '好的，以下是完整的单元测试：...',
        },
      ];

      const purged = purgeStaleContextStateBubbles(messages);

      expect(purged.map((m) => m.id)).toEqual([
        'msg-u1',
        'msg-a1',
        'msg-u2',
        'msg-a2',
      ]);
      expect(purged.map((m) => m.text)).toEqual([
        '请帮我实现一个 LRU 缓存',
        '好的，这是 LRU 缓存的实现方案：...',
        '请为这个 LRU 补充单元测试',
        '好的，以下是完整的单元测试：...',
      ]);
    });

    it('支持多种脏数据变体（[系统环境提示：]前缀、收到/好的等废话回复、metadata 标记）并连带修剪', () => {
      const messages: SessionMessage[] = [
        // 变体 1: 带有 [系统环境提示：] 前缀
        {
          id: 'stale-1-u',
          sender: 'user',
          timestamp: 1000,
          text: '[系统环境提示：] 当前已切换到模型 claude-3-5-sonnet。权限模式：default。',
        },
        {
          id: 'stale-1-a',
          sender: 'assistant',
          timestamp: 1001,
          text: '好的。当前配置已更新。',
        },
        // 变体 2: 带 metadata kind context-state
        {
          id: 'stale-2-u',
          sender: 'user',
          timestamp: 2000,
          text: '当前已切换到模型 deepseek-chat（服务商 deepseek）',
          metadata: { kind: 'context-state' },
        },
        {
          id: 'stale-2-a',
          sender: 'assistant',
          timestamp: 2001,
          text: '收到。当前配置：deepseek-chat',
        },
        // 变体 3: 孤儿无伴生回复（例如被截断或只留下了伪用户消息）
        {
          id: 'stale-3-u',
          sender: 'user',
          timestamp: 3000,
          text: '当前已切换到模型 gpt-4o。思考档位：Low。',
        },
        // 正常对话
        {
          id: 'normal-u',
          sender: 'user',
          timestamp: 4000,
          text: '帮我查一下今日汇率',
        },
        {
          id: 'normal-a',
          sender: 'assistant',
          timestamp: 5000,
          text: '今日美元兑人民币汇率为 7.23。',
        },
      ];

      const purged = purgeStaleContextStateBubbles(messages);
      expect(purged.map((m) => m.id)).toEqual(['normal-u', 'normal-a']);
      expect(purged.map((m) => m.text)).toEqual([
        '帮我查一下今日汇率',
        '今日美元兑人民币汇率为 7.23。',
      ]);
    });

    it('包含正常用户输入（如包含 [用户输入] 与 [系统环境上下文]）时，验证绝不误伤', () => {
      const messages: SessionMessage[] = [
        {
          id: 'msg-u-composite',
          sender: 'user',
          timestamp: 1000,
          text: '[用户输入]\n请帮我分析这个报错日志\n\n[系统环境上下文]\n当前已切换到模型 ornith:latest（服务商 ollama）。权限模式：full。思考档位：Max。',
        },
        {
          id: 'msg-a-reply',
          sender: 'assistant',
          timestamp: 2000,
          text: '分析结果：日志显示连接超时，建议排查端口绑定。',
        },
      ];

      const purged = purgeStaleContextStateBubbles(messages);
      // 必须完整保留，不能将高内聚 [用户输入] 消息误判为孤儿脏数据！
      expect(purged).toHaveLength(2);
      expect(purged[0]!.id).toBe('msg-u-composite');
      expect(purged[0]!.text).toContain('[用户输入]');
      expect(purged[0]!.text).toContain('[系统环境上下文]');
      expect(purged[1]!.id).toBe('msg-a-reply');
      expect(purged[1]!.text).toBe(
        '分析结果：日志显示连接超时，建议排查端口绑定。'
      );
    });

    it('包含普通用户对话与工具调用时，验证完整保留', () => {
      const messages: SessionMessage[] = [
        {
          id: 'msg-u-tools',
          sender: 'user',
          timestamp: 1000,
          text: '运行 git status 看看当前修改',
        },
        {
          id: 'msg-a-tools',
          sender: 'assistant',
          timestamp: 2000,
          text: '好的，正在执行命令。',
          toolCalls: [
            {
              id: 'tc-git-1',
              name: 'run_command',
              arguments: '{"CommandLine":"git status"}',
              status: 'success',
              output: 'On branch main\nnothing to commit',
            },
          ],
        },
        {
          id: 'msg-u-query',
          sender: 'user',
          timestamp: 3000,
          text: '新切换的模型为什么在控制台没有响应？',
        },
        {
          id: 'msg-a-query',
          sender: 'assistant',
          timestamp: 4000,
          text: '请检查本地 Ollama 服务是否正在运行，端口 11434 是否可达。',
          toolCalls: [],
        },
      ];

      const purged = purgeStaleContextStateBubbles(messages);
      expect(purged).toHaveLength(4);
      expect(purged.map((m) => m.id)).toEqual([
        'msg-u-tools',
        'msg-a-tools',
        'msg-u-query',
        'msg-a-query',
      ]);
      expect(purged[1]!.toolCalls).toHaveLength(1);
      expect(purged[1]!.toolCalls?.[0]?.name).toBe('run_command');
      expect(purged[1]!.toolCalls?.[0]?.output).toBe(
        'On branch main\nnothing to commit'
      );
    });

    it('sanitizeMessagesForHydrate 管道中正确集成自愈：清除脏孤儿对、收敛未完成状态并赋予严格单调 sequence', () => {
      const dirtyMessages: SessionMessage[] = [
        {
          id: 'u-1',
          sender: 'user',
          timestamp: 1000,
          text: '第一问',
        },
        {
          id: 'a-1',
          sender: 'assistant',
          timestamp: 2000,
          text: '第一答',
        },
        // 历史脏孤儿对
        {
          id: 'u-stale',
          sender: 'user',
          timestamp: 3000,
          text: '当前已切换到模型 claude-3-5-sonnet',
        },
        {
          id: 'a-stale',
          sender: 'assistant',
          timestamp: 3001,
          text: '明白了。当前配置：claude-3-5-sonnet',
        },
        // 未收敛流式消息
        {
          id: 'u-2',
          sender: 'user',
          timestamp: 4000,
          text: '第二问',
        },
        {
          id: 'a-2',
          sender: 'assistant',
          timestamp: 5000,
          status: 'processing',
          text: '正在思考中...',
        },
      ];

      const result = sanitizeMessagesForHydrate(dirtyMessages);

      // 脏孤儿对必须被彻底清除，剩余 4 条消息
      expect(result.map((m) => m.id)).toEqual(['u-1', 'a-1', 'u-2', 'a-2']);
      expect(result.map((m) => m.text)).toEqual([
        '第一问',
        '第一答',
        '第二问',
        '正在思考中...',
      ]);
      // a-2 状态收敛为 completed
      expect(result[3]!.status).toBe('completed');
      // engineSequence 保持严格单调自增
      expect(result.map((m) => m.engineSequence)).toEqual([0, 1, 2, 3]);
    });
  });
});
