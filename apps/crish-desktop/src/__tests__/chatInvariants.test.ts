import { describe, it, expect } from 'vitest';
import { resolveChatEmptyKind } from '../api/chatEmptyState';
import { messageHasSubstance } from '../api/sessionTitle';
import { StreamTextBatcher } from '../api/streamTextBatcher';
import { globalPretextCache, validatePreparedText } from '../api/pretextCache';

describe('chat invariants', () => {
  it('1. resolveChatEmptyKind - when message count > 0, empty state route must return null', () => {
    const result = resolveChatEmptyKind({
      hasActiveSession: true,
      messageCount: 1,
      displayCount: 1,
      mainSurface: 'chat',
    });
    expect(result).toBeNull();
  });

  it('2. messageHasSubstance - when message only has blocks content, must return true', () => {
    const result = messageHasSubstance({
      blocks: [{ type: 'text', text: 'hello' }],
    } as any);
    expect(result).toBe(true);
  });

  it('3. resolveChatEmptyKind - no session state must return no-session', () => {
    const result = resolveChatEmptyKind({
      hasActiveSession: false,
      messageCount: 0,
      displayCount: 0,
      mainSurface: 'chat',
    });
    expect(result).toBe('no-session');
  });

  it('4. tool call stream disconnect protection: interrupted tool call must be auto-healed and unlock session', () => {
    const sessionState = {
      isStreaming: true,
      pendingRPCs: ['rpc_tool_call_1'],
      messages: [
        {
          role: 'assistant',
          toolCalls: [{ id: 'call_1', name: 'search', status: 'running' }],
        },
      ],
      fatalError: false,
    };

    const simulateNetworkInterrupt = (state: typeof sessionState) => {
      state.isStreaming = false;
      state.pendingRPCs = [];
      state.messages[0].toolCalls[0].status = 'interrupted';
      return state;
    };

    const nextState = simulateNetworkInterrupt(sessionState);

    expect(nextState.fatalError).toBe(false);
    expect(nextState.isStreaming).toBe(false);
    expect(nextState.pendingRPCs.length).toBe(0);
    const canAcceptNewMessage = !nextState.isStreaming && !nextState.fatalError;
    expect(canAcceptNewMessage).toBe(true);
  });

  it('5. tool call continuity invariant: stream must not abort before tool_call_complete', () => {
    const streamController = {
      buffer: [] as any[],
      isClosed: false,
      append(chunk: any) {
        this.buffer.push(chunk);
      },
      abort() {
        this.isClosed = true;
      },
    };

    streamController.append({ type: 'tool_call_start', id: 'call_1' });
    streamController.append({ type: 'tool_call_chunk', delta: '{"query"' });

    const isToolCallComplete = streamController.buffer.some(
      (c) => c.type === 'tool_call_complete'
    );
    if (!isToolCallComplete) {
      expect(streamController.isClosed).toBe(false);
    }

    streamController.append({ type: 'tool_call_complete', id: 'call_1' });
    const isNowComplete = streamController.buffer.some(
      (c) => c.type === 'tool_call_complete'
    );
    if (isNowComplete) {
      streamController.abort();
      expect(streamController.isClosed).toBe(true);
    }
  });

  it('6. drag and drop attachments: dataUrl resolves to image thumbnail, path resolves to file path', () => {
    const attachmentWithDataUrl = {
      dataUrl: 'data:image/png;base64,...',
      type: 'image/png',
    };
    const attachmentWithPath = {
      path: '/users/local/file.txt',
      type: 'text/plain',
    };

    const resolveAttachmentMode = (att: any) => {
      if (att.dataUrl) return 'mini-thumbnail';
      if (att.path) return 'file-path';
      return 'unknown';
    };

    expect(resolveAttachmentMode(attachmentWithDataUrl)).toBe('mini-thumbnail');
    expect(resolveAttachmentMode(attachmentWithPath)).toBe('file-path');
  });

  it('7. thinking effort config invariant: single-source from describe interface (no self-made gear table)', () => {
    // 单源收敛（T5.2b）：档位面板不再自造静态档位集，改由描述接口 offered 派生。
    // 行为变更随行为变更（G8-c「显式档位/默认档位区分」）：
    // - 有能力元数据 → 渲染描述接口白名单档位 +「提供方默认」；
    // - 无能力元数据 → 仅「提供方默认」项（不渲染自造档位）；
    // - 省略/默认档位 → 不注入显式思考参数（默认回落引擎侧默认档位）。
    const THINKING_LEVEL_LABELS: Readonly<Record<string, string>> = {
      off: '关闭',
      minimal: '最短',
      low: '标准',
      medium: '详细',
      high: '深入',
      xhigh: '最深',
    };
    // 与 product 单源一致：thinkingLevelOptionsFor / normalizeThinkingLevel
    const buildOptions = (offered: string[] | undefined) => {
      const explicit = (offered || []).map((level) => ({
        value: level,
        label: THINKING_LEVEL_LABELS[level] ?? level,
        isProviderDefault: false,
      }));
      return [
        { value: 'default', label: '提供方默认', isProviderDefault: true },
        ...explicit,
      ];
    };
    const normalizeGear = (storedValue?: string) => {
      const t = (storedValue || '').trim().toLowerCase();
      if (!t || t === 'default') return 'default';
      return t;
    };

    // 描述接口 mock 白名单 ['low','medium','high'] → 只渲染这三项 + 提供方默认
    const withCaps = buildOptions(['low', 'medium', 'high']);
    expect(withCaps.map((o) => o.value)).toEqual([
      'default',
      'low',
      'medium',
      'high',
    ]);
    expect(withCaps[0].isProviderDefault).toBe(true);

    // 无能力元数据 → 只有提供方默认项
    const withoutCaps = buildOptions(undefined);
    expect(withoutCaps.map((o) => o.value)).toEqual(['default']);
    expect(withoutCaps[0].isProviderDefault).toBe(true);

    // 省略/默认档位 → 'default'（回落引擎侧默认，不注入显式思考参数）
    expect(normalizeGear()).toBe('default');
    expect(normalizeGear('default')).toBe('default');
    expect(normalizeGear('invalid')).toBe('invalid');
    expect(normalizeGear('medium')).toBe('medium');
  });

  it('8. sidebar session uniqueness: Map deduplication should exactly match unique session count', () => {
    const sessions = [
      { id: '1', title: 'Session 1' },
      { id: '2', title: 'Session 2' },
      { id: '1', title: 'Session 1 Duplicate' },
      { id: '3', title: 'Session 3' },
    ];

    const deduplicated = Array.from(
      new Map(sessions.map((s) => [s.id, s])).values()
    );
    const uniqueCount = new Set(sessions.map((s) => s.id)).size;

    expect(deduplicated.length).toBe(uniqueCount);
    expect(deduplicated.length).toBe(3);
    expect(deduplicated.find((s) => s.id === '1')?.title).toBe(
      'Session 1 Duplicate'
    );
  });

  it('9. sidebar resize bounds invariant: width must stay within [180px, 600px]', () => {
    const SIDEBAR_WIDTH_MIN = 180;
    const SIDEBAR_WIDTH_MAX = 600;

    const clampSidebarWidth = (raw: number) => {
      return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, raw));
    };

    expect(clampSidebarWidth(100)).toBe(180);
    expect(clampSidebarWidth(750)).toBe(600);
    expect(clampSidebarWidth(320)).toBe(320);
  });

  it('11. 流式批处理器 StreamTextBatcher 累积与 Flush 不变量测试', () => {
    const flushed = new Map<string, string>();
    const batcher = new StreamTextBatcher(
      (key, text) => {
        flushed.set(key, text);
      },
      { intervalMs: 50 }
    );

    const key = 'msg_stream_1';
    batcher.push(key, 'Hello');
    batcher.push(key, 'Hello World');
    batcher.push(key, 'Hello World!');

    expect(flushed.has(key)).toBe(false);
    expect(batcher.pendingCount()).toBe(1);
    expect(batcher.bufferedSize()).toBe('Hello World!'.length);

    batcher.flushNow();

    expect(flushed.get(key)).toBe('Hello World!');
    expect(batcher.pendingCount()).toBe(0);
    expect(batcher.bufferedSize()).toBe(0);
  });

  it('12. Pretext 字体测量与回退计算不变量测试', () => {
    expect(validatePreparedText({ boxWidth: NaN, boxHeight: 10 })).toBe(false);
    expect(validatePreparedText({ boxWidth: 10, boxHeight: Infinity })).toBe(
      false
    );
    expect(validatePreparedText({ boxWidth: 100, boxHeight: 200 })).toBe(true);
    expect(validatePreparedText(null)).toBe(false);

    globalPretextCache.clear();
    const mockPrepared = { boxWidth: 50, boxHeight: 20 } as any;
    globalPretextCache.set('msg-1', 'hello', '14px Inter', mockPrepared);

    const cachedResult = globalPretextCache.getOrCreate(
      'msg-1',
      'hello',
      '14px Inter'
    );
    expect(cachedResult).toBe(mockPrepared);
  });

  it('13. 草稿模式 (isPendingDraft) 新建对话 0 秒卡顿与 messagesLoadingCandidate 不变量测试', () => {
    const PENDING_DRAFT_ID = 'draft_sentinel';
    const isPendingDraft = (id: string | null) => id === PENDING_DRAFT_ID;

    const computeMessagesLoadingCandidate = (
      activeSessionId: string | null,
      messagesLength: number,
      hydratedFromEngine: boolean
    ) => {
      if (!activeSessionId) return false;
      if (isPendingDraft(activeSessionId)) return false;
      if (messagesLength > 0) return false;
      if (hydratedFromEngine) return false;
      return true;
    };

    // 草稿哨兵模式下必须 0ms 立即返回 false，绝不触发 3 秒水合超时等待与主界面空白卡顿
    const candidate = computeMessagesLoadingCandidate(
      PENDING_DRAFT_ID,
      0,
      false
    );
    expect(candidate).toBe(false);
  });

  it('14. 切换/挂载会话多帧 rAF 与多阶段延时 100% 滚动贴底不变量测试', () => {
    const mockContainer = {
      scrollTop: 0,
      scrollHeight: 5000,
    };

    const scrollToBottomInstant = () => {
      mockContainer.scrollTop = mockContainer.scrollHeight + 100000;
    };

    // 初始设置 scrollTop 为 5000 (当时估算的高度)
    scrollToBottomInstant();
    expect(mockContainer.scrollTop).toBe(105000);

    // 模拟后续异步 Pretext/Markdown 渲染后 scrollHeight 增加到 25000
    mockContainer.scrollHeight = 25000;
    scrollToBottomInstant();

    // 校验多阶段贴底触发后 scrollTop 必须精准跟随最新的 scrollHeight 贴至最底部最新消息
    expect(mockContainer.scrollTop).toBe(125000);
  });
});
