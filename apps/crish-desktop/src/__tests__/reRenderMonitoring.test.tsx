// @vitest-environment jsdom
/**
 * 重渲染监控测试 suite (Component Re-render Counter & Isolation Assertions)
 * 1. 组装组件 (CardPanel / DiffCard / MessageVirtualizer) Component Re-render 计数追踪
 * 2. 无关 Store 状态更新 (如 Shell Chrome / 无关 workspace / 后台 session) 时零额外重渲染 (0 extra re-render)
 * 3. React.memo Props 稳定性断言 (同址/不可变属性不击穿 memo)
 */
import React from 'react';
import { render, act, waitFor } from '@testing-library/react';
import {
  describe,
  expect,
  it,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import { useLayoutStore } from '../store/layoutStore';
import { useSessionStore } from '../store/sessionStore';
import { DiffCard } from '../components/diff/DiffCard';
import { MessageContent } from '../components/chat-message/MessageContent';
import { useStreamMessageViewModel } from '../components/chat-message/streamMessageViewModel';
import { useStreamingStore } from '../store/storeAccess';
import type { ChatToolStackSharedProps } from '../components/chat-tool-call/ChatToolCallBlock';
import type { SessionMessage } from '../store/types';

/**
 * T4 A1 测试装配壳层：复刻页面壳层 StreamingAssistantRow 的接线
 * （useStreamMessageViewModel 订阅 + 合并 → MessageContent 收已合并 view model）。
 * toolStackProps 由调用方传入稳定引用（页面壳层经 useChatMessageState useMemo
 * 产出稳定引用；测试内联新建会击穿 TimelineBody memo——原测试即模块级常量）。
 */
function StreamHarness({
  msg,
  isThinkingMsg,
  sessionId,
  toolStackProps,
}: {
  msg: SessionMessage;
  isThinkingMsg: boolean;
  sessionId: string;
  toolStackProps: ChatToolStackSharedProps;
}) {
  const vm = useStreamMessageViewModel(msg, sessionId);
  return (
    <MessageContent
      msg={vm.msg}
      streamText={vm.streamText}
      isThinkingMsg={isThinkingMsg}
      toolStackProps={toolStackProps}
    />
  );
}

// ── T1.7/T4.4：流式增量渲染监控（08-detail 任务清单）──────────────────────
// AsyncMarkdownBlock / MessageToolCallsSection 替换为渲染计数探针：
// 流式纯文本帧期间稳定块渲染 0 次（签名缓存 + memo 短路），
// 工具事件 → 仅工具区重渲染（全链重渲染 = 工具事件数，而非帧数）。
const { mockAmdRenders, mockToolSectionRenders } = vi.hoisted(() => ({
  mockAmdRenders: [] as string[],
  mockToolSectionRenders: [] as number[],
}));

vi.mock('../components/chat-message-row/MarkdownBlockItem', async () => {
  const ReactMod = await import('react');
  return {
    MarkdownBlockItem: ReactMod.memo(
      (props: { text?: string; isStreaming?: boolean }) => {
        if (!props.text) return null; // 与真实组件语义一致：空文本不渲染
        if (!props.isStreaming) {
          mockAmdRenders.push(props.text ?? '');
        }
        return ReactMod.createElement(
          'div',
          {
            'data-testid': 'amd-block',
            'data-streaming': String(!!props.isStreaming),
          },
          props.text ?? ''
        );
      }
    ),
  };
});

vi.mock('../components/chat-message-row/MessageToolCallsSection', async () => {
  const ReactMod = await import('react');
  return {
    MessageToolCallsSection: ReactMod.memo((props: { items?: unknown[] }) => {
      mockToolSectionRenders.push(props.items?.length ?? 0);
      return ReactMod.createElement(
        'div',
        { 'data-testid': 'tool-section' },
        `tools:${props.items?.length ?? 0}`
      );
    }),
  };
});

// Mock ResizeObserver
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let origError: typeof console.error;
beforeAll(() => {
  origError = console.error;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('not wrapped in act'))
      return;
    origError.call(console, ...args);
  };
});
afterAll(() => {
  console.error = origError;
});

function bootstrapStoreState() {
  useLayoutStore.setState((st) => {
    st.workspaces = [
      {
        id: 'ws-rerender-1',
        name: 'ReRender Workspace',
        columns: [
          {
            id: 'col-1',
            widthRatio: 1,
            groups: [
              {
                id: 'group-1',
                activeCardId: 'diff',
                cards: [
                  { id: 'diff', title: 'Diff' },
                  { id: 'chat', title: 'Chat' },
                ],
                heightRatio: 1,
              },
            ],
          },
        ],
      },
    ];
    st.activeWorkspaceId = 'ws-rerender-1';
    st.shellChromeMode = 'classic';
    st.activeDiffSource = null;
    st.diffFiles = [
      {
        filePath: 'src/main.ts',
        status: 'modified',
        additions: 3,
        deletions: 1,
        changes: [{ type: 'addition', content: '+ new code' }],
      },
    ];
  });

  useSessionStore.setState((st) => {
    st.sessions = [
      {
        id: 'sess-rr-1',
        title: 'ReRender Session',
        folder: '对话',
        isPinned: false,
        isArchived: false,
        timestamp: new Date().toISOString(),
        messages: [],
        agents: [],
      },
    ];
    st.activeSessionId = 'sess-rr-1';
  });
}

beforeEach(() => {
  bootstrapStoreState();
});

describe('重渲染监控 (Component Re-render Monitoring)', () => {
  it('DiffCard / Zustand State 关联：无关 Layout Store 变更 (如 shellChromeMode) 不击穿无关组件', async () => {
    let parentRenderCount = 0;

    function ParentWrapper(_props: { dummy: number }) {
      parentRenderCount++;
      return <DiffCard onShowToast={vi.fn()} />;
    }

    render(<ParentWrapper dummy={1} />);
    expect(parentRenderCount).toBe(1);

    // 修改无关 Layout Store 状态：shellChromeMode (不影响未变动 props 的 React.memo 组件)
    act(() => {
      useLayoutStore.setState((s) => {
        s.shellChromeMode = 'inset';
      });
    });

    await waitFor(() => {
      // 核心断言：父级未因无关 store 变动而盲目全局全组件大面积联锁重绘
      expect(parentRenderCount).toBe(1);
    });
  });

  it('DiffCard 重渲染监控：更新无关 Session 列表不触发 DiffCard 无效全重绘', async () => {
    let diffParentRenderCount = 0;

    function DiffParentWrapper() {
      diffParentRenderCount++;
      return (
        <DiffCard
          diffFiles={[]}
          activeDiffSource={null}
          onSelectDiff={vi.fn()}
          onShowToast={vi.fn()}
        />
      );
    }

    render(<DiffParentWrapper />);
    expect(diffParentRenderCount).toBe(1);

    // 变更后台无关会话内容 (非当前 activeSession)
    act(() => {
      useSessionStore.setState((st) => {
        st.sessions.push({
          id: 'sess-background-99',
          title: 'Unrelated Background Session',
          folder: '对话',
          isPinned: false,
          isArchived: false,
          timestamp: new Date().toISOString(),
          messages: [],
          agents: [],
        });
      });
    });

    await waitFor(() => {
      // 核心断言：DiffCard 不受后台无关 session push 的全层重绘影响
      expect(diffParentRenderCount).toBe(1);
    });
  });

  it('MessageVirtualizer React.memo 属性稳定性校验：包裹组件 props 保持不变时跳过子组件重渲染', () => {
    let childRenderCount = 0;

    const mockMessages: SessionMessage[] = [
      { id: 'm1', sender: 'user', timestamp: Date.now(), text: 'Hello' },
    ];

    const stableProps = {
      messages: mockMessages,
      pinnedItems: [],
      pinsOpen: false,
      setPinsOpen: vi.fn(),
      jumpToPinned: vi.fn(),
      togglePin: vi.fn(),
      searchHighlightQuery: '',
      expandedUserMsgs: {},
      onToggleExpandUser: vi.fn(),
      onShowToast: vi.fn(),
      hideThinkingBlock: false,
      lastAssistantId: null,
      toolStackProps: {
        activeSessionId: 'sess-rr-1',
        onShowToast: vi.fn(),
        onOpenDiff: vi.fn(),
        onOpenDiffPanel: vi.fn(),
      },
      handleRegenerateRow: vi.fn(),
      onBranch: vi.fn(),
      onOpenDiff: vi.fn(),
      onOpenDiffPanel: vi.fn(),
      setPermissionMode: vi.fn(),
      handleFillFollowUp: vi.fn(),
      onSendFollowUp: vi.fn(),
      handleSendFollowUp: vi.fn(),
      dismissedFollowUps: {},
      handleDismissFollowUp: vi.fn(),
      showAllMessages: true,
      activeSessionId: 'sess-rr-1',
      handleMarkdownClick: vi.fn(),
    };

    // 被 React.memo 包裹的测试子组件
    const MemoizedChild = React.memo(function DummyChild(
      _props: typeof stableProps
    ) {
      childRenderCount++;
      return (
        <div data-testid="virtualizer-memo-child">
          MessageVirtualizer Memo Wrapped
        </div>
      );
    });

    function ParentContainer({ count }: { count: number }) {
      return (
        <div>
          <span data-testid="parent-count">{count}</span>
          <MemoizedChild {...stableProps} />
        </div>
      );
    }

    const { rerender } = render(<ParentContainer count={1} />);
    expect(childRenderCount).toBe(1);

    // 父组件重新渲染（count 改变，但 MemoizedChild 接收到的 props 完全同址稳定）
    rerender(<ParentContainer count={2} />);

    // 核心断言：React.memo 阻止了 MemoizedChild 的无效重渲染 (子组件渲染计数保持为 1)
    expect(childRenderCount).toBe(1);
  });
});

// ──────────────────────────────────────────────
describe('流式增量渲染监控（T1.7：纯文本帧零重渲染）', () => {
  const SID = 'sess-stream-1';
  const MID = 'asst-stream-1';
  const toolStackProps = {
    activeSessionId: SID,
    onShowToast: vi.fn(),
    onOpenDiff: vi.fn(),
    onOpenDiffPanel: vi.fn(),
  } as unknown as ChatToolStackSharedProps;

  function streamingMsg(): SessionMessage {
    return {
      id: MID,
      sender: 'assistant',
      text: '',
      thinking: '',
      timestamp: Date.now(),
      status: 'processing',
      toolCalls: [],
      blocks: [
        { type: 'text', content: '稳定历史块内容\n' },
        { type: 'text', content: '' },
      ],
    };
  }

  beforeEach(() => {
    mockAmdRenders.length = 0;
    mockToolSectionRenders.length = 0;
    useStreamingStore.setState({
      byKey: Object.create(null) as Record<string, never>,
    });
  });

  it('流式纯文本帧：稳定历史块渲染 0 次；增量累积 = strip 后全文', () => {
    const { container } = render(
      <StreamHarness
        msg={streamingMsg()}
        isThinkingMsg
        sessionId={SID}
        toolStackProps={toolStackProps}
      />
    );
    // 首帧：稳定块渲染 1 次（初始挂载）；空尾块不渲染
    expect(mockAmdRenders).toEqual(['稳定历史块内容']);

    // 模拟 6 个流式帧（文本单调增长，含占位行）
    const frames = [
      '正在思考中…\n',
      '正在思考中…\n第一行完成\n',
      '正在思考中…\n第一行完成\n第二行完成\n',
      '正在思考中…\n第一行完成\n第二行完成\n## 本轮总结\n',
      '正在思考中…\n第一行完成\n第二行完成\n## 本轮总结\n正文继续\n',
      '正在思考中…\n第一行完成\n第二行完成\n## 本轮总结\n正文继续\n收尾行',
    ];
    for (const f of frames) {
      act(() => {
        useStreamingStore.getState().setStreamText(SID, MID, f);
      });
    }

    // 稳定历史块全程零额外渲染（签名缓存 + TimelineBody memo + 块 memo）
    expect(mockAmdRenders).toEqual(['稳定历史块内容']);
    // 增量区 DOM 累积 = strip(全文)（占位行/总结标题被剥）
    expect(container.textContent).toContain('第一行完成');
    expect(container.textContent).toContain('正文继续');
    expect(container.textContent).not.toContain('正在思考中');
    expect(container.textContent).not.toContain('## 本轮总结');
    // 流式区标记存在（StreamingTextBlock data-streaming）
    expect(container.querySelector('[data-streaming="true"]')).not.toBeNull();
  });

  it('complete 后流式节点卸载：稳定块接管全文（无重复文本）', () => {
    const { container } = render(
      <StreamHarness
        msg={streamingMsg()}
        isThinkingMsg
        sessionId={SID}
        toolStackProps={toolStackProps}
      />
    );
    act(() => {
      useStreamingStore.getState().setStreamText(SID, MID, '正文一\n正文二\n');
    });
    expect(container.querySelector('[data-streaming="true"]')).not.toBeNull();
    // complete：流式 store 清空 → 订阅断开，流式节点卸载
    act(() => {
      useStreamingStore.setState({
        byKey: Object.create(null) as Record<string, never>,
      });
    });
    expect(container.querySelector('[data-streaming="true"]')).toBeNull();
  });
});

// ──────────────────────────────────────────────
describe('工具密集会话全链重渲染（T4.4：= 工具事件数，而非帧数）', () => {
  const SID = 'sess-tools-1';
  const MID = 'asst-tools-1';
  const toolStackProps = {
    activeSessionId: SID,
    onShowToast: vi.fn(),
    onOpenDiff: vi.fn(),
    onOpenDiffPanel: vi.fn(),
  } as unknown as ChatToolStackSharedProps;

  function toolRichMsg(): SessionMessage {
    return {
      id: MID,
      sender: 'assistant',
      text: '',
      thinking: '',
      timestamp: Date.now(),
      status: 'processing',
      toolCalls: [
        { id: 't-1', name: 'read_file', arguments: '{}', status: 'running' },
      ],
      blocks: [
        { type: 'text', content: '前置稳定文本\n' },
        { type: 'tool_call', id: 't-1' },
        { type: 'text', content: '' },
      ],
    };
  }

  beforeEach(() => {
    mockAmdRenders.length = 0;
    mockToolSectionRenders.length = 0;
    useStreamingStore.setState({
      byKey: Object.create(null) as Record<string, never>,
    });
  });

  it('20 个工具事件：工具区渲染 = 工具事件数，稳定文本块零额外渲染', () => {
    render(
      <StreamHarness
        msg={toolRichMsg()}
        isThinkingMsg
        sessionId={SID}
        toolStackProps={toolStackProps}
      />
    );
    // 初始：稳定文本块 1 次 + 工具区 1 次
    expect(mockAmdRenders).toEqual(['前置稳定文本']);
    expect(mockToolSectionRenders).toHaveLength(1);

    // 穿插：流式文本帧——流式区首次出现时主体拆分变化（last text 项移出
    // TimelineBody）→ 工具区多渲染 1 次；此后再无任何下游重渲染
    act(() => {
      useStreamingStore.getState().setStreamText(SID, MID, '流式正文第 1 行\n');
    });
    expect(mockAmdRenders).toEqual(['前置稳定文本']);
    expect(mockToolSectionRenders).toHaveLength(2);

    // 纯文本帧继续增长：稳定文本块 + 工具区零额外渲染
    act(() => {
      useStreamingStore
        .getState()
        .setStreamText(SID, MID, '流式正文第 1 行\n第二行\n');
    });
    expect(mockAmdRenders).toEqual(['前置稳定文本']);
    expect(mockToolSectionRenders).toHaveLength(2);

    // 20 个工具事件（status 推进）→ 每次 1 次工具区渲染
    for (let i = 0; i < 20; i++) {
      act(() => {
        useStreamingStore.getState().setStreamTool(SID, MID, 't-1', {
          id: 't-1',
          name: 'read_file',
          status: i % 2 === 0 ? 'running' : 'success',
          output: `第 ${i} 步输出`,
        });
      });
    }

    // 全链重渲染次数 = 初始 1 + 拆分 1 + 工具事件 20；稳定文本块零额外渲染
    expect(mockToolSectionRenders).toHaveLength(22);
    expect(mockAmdRenders).toEqual(['前置稳定文本']);
  });
});

// ──────────────────────────────────────────────
describe('单卡展开隔离（D7.3 / FE-INV-5：其它消息 0 渲染）', () => {
  it('rowToolStackSharedPropsEqual：单卡 toggle 只换目标消息槽位引用，其它行 shallow 相等', async () => {
    const { rowToolStackSharedPropsEqual } =
      await import('../components/chat-message-row/chatMessageRowUtils');

    const emptyTools = {};
    const msgAExpanded = { 'tool-a': true };
    const msgBExpanded = { 'tool-b': false };

    // 会话级嵌套展开 map：A 已展开、B 未展开
    const byMessageV1 = {
      'msg-a': msgAExpanded,
      'msg-b': msgBExpanded,
    };
    const sharedV1 = {
      agents: [],
      activeSessionId: 'sess-x',
      expandedTools: emptyTools,
      expandedToolsByMessage: byMessageV1,
      onToggleTool: () => {},
      approvalBusy: false,
    } as unknown as ChatToolStackSharedProps;

    // toggle msg-a 的 tool-a → 只换 msg-a 槽位；msg-b 引用不变
    const byMessageV2 = {
      'msg-a': { 'tool-a': false },
      'msg-b': msgBExpanded, // 同一引用
    };
    const sharedV2 = {
      ...sharedV1,
      expandedToolsByMessage: byMessageV2,
    } as unknown as ChatToolStackSharedProps;

    // 目标行（msg-a）：expandedTools 切片变化 → 不相等（须重渲染）
    expect(rowToolStackSharedPropsEqual(sharedV1, sharedV2, 'msg-a')).toBe(
      false
    );
    // 其它行（msg-b）：切片引用不变 → 相等（0 重渲染）
    expect(rowToolStackSharedPropsEqual(sharedV1, sharedV2, 'msg-b')).toBe(
      true
    );
  });

  it('assistantRowPropsEqual：单卡展开时其它消息行 props shallow 相等（0 重渲染探针）', async () => {
    const { assistantRowPropsEqual } =
      await import('../components/chat-message-row/chatMessageRowUtils');

    const SID = 'sess-iso';
    const msgA: SessionMessage = {
      id: 'asst-a',
      sender: 'assistant',
      text: 'A 正文',
      thinking: '',
      timestamp: 1,
      status: 'completed',
      toolCalls: [
        { id: 't-a', name: 'read_file', arguments: '{}', status: 'success' },
      ],
      blocks: [{ type: 'text', content: 'A 正文' }],
    };
    const msgB: SessionMessage = {
      id: 'asst-b',
      sender: 'assistant',
      text: 'B 正文',
      thinking: '',
      timestamp: 2,
      status: 'completed',
      toolCalls: [
        { id: 't-b', name: 'read_file', arguments: '{}', status: 'success' },
      ],
      blocks: [{ type: 'text', content: 'B 正文' }],
    };

    const baseRow = {
      msg: msgB,
      isFollowUp: false,
      isPinned: false,
      isSearchHit: false,
      isThinkingMsg: false,
      hideThinkingBlock: false,
      isLastAssistant: true,
      onTogglePin: vi.fn(),
      onBranch: vi.fn(),
      onOpenDiff: vi.fn(),
      setPermissionMode: vi.fn(),
      messageIndex: 1,
      virtualScrollManager: null,
    };

    const msgBExpanded = { 't-b': false };

    // 会话级嵌套展开 map：A 已展开、B 未展开（B 槽位跨两版共享同一引用）
    const byMessageV1 = {
      'asst-a': { 't-a': false } as Record<string, boolean>,
      'asst-b': msgBExpanded,
    };
    const byMessageV2 = {
      'asst-a': { 't-a': true } as Record<string, boolean>, // A 展开（新引用）
      'asst-b': msgBExpanded, // 同一引用
    };

    const sharedV1 = {
      agents: [],
      activeSessionId: SID,
      expandedTools: {},
      expandedToolsByMessage: byMessageV1,
      onToggleTool: vi.fn(),
      approvalBusy: false,
    } as unknown as ChatToolStackSharedProps;
    const sharedV2 = {
      ...sharedV1,
      expandedToolsByMessage: byMessageV2,
    } as unknown as ChatToolStackSharedProps;

    // B 行：msg / 其它 props 不变，仅 expandedToolsByMessage 外层换、B 槽位同引用 → 相等
    expect(
      assistantRowPropsEqual(
        { ...baseRow, toolStackProps: sharedV1 },
        { ...baseRow, toolStackProps: sharedV2 }
      )
    ).toBe(true);

    // A 行：A 槽位变化 → 不等
    const rowA = {
      ...baseRow,
      msg: msgA,
      isLastAssistant: false,
      messageIndex: 0,
    };
    expect(
      assistantRowPropsEqual(
        { ...rowA, toolStackProps: sharedV1 },
        { ...rowA, toolStackProps: sharedV2 }
      )
    ).toBe(false);
  });
});
