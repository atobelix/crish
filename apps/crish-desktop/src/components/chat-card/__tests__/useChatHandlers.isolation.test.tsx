// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { LeafScopeProvider } from '../../../contexts/LeafScopeContext';
import { useChatHandlers } from '../useChatHandlers';
import { useChatProjectPicker } from '../useChatProjectPicker';
import { emitUiEvent } from '../../../api/uiEvents';
import { useSessionStore } from '../../../store/sessionStore';
import { useLayoutStore } from '../../../store/storeAccess';

const mockWithdrawMessage = vi.fn();
const mockSetSessionMessageStatus = vi.fn();
const mockSessionsById: Record<string, any> = {};
const mockTryDownloadSessionMarkdown = vi.fn().mockReturnValue({ ok: true });
const mockPreviewConversationRewind = vi.fn().mockResolvedValue({
  ok: true,
  raw: { type: 'preview' },
});

vi.mock('../../../app/compositionRoot', () => ({
  getCompositionRoot: () => ({
    session: {
      getState: () => ({
        sessionsById: mockSessionsById,
        withdrawMessage: mockWithdrawMessage,
        setSessionMessageStatus: mockSetSessionMessageStatus,
        setComposerDraft: vi.fn(),
      }),
    },
  }),
}));

vi.mock('../../../store/storeAccess', () => {
  return {
    clearRuntimeStatus: vi.fn(),
    reportRuntimeStatus: vi.fn(),
    openToolInSession: vi.fn(),
    useSettingsField: (sel: (s: any) => any) =>
      sel({ appSettings: { maxRetryAttempts: 10 } }),
    useLayoutStore: Object.assign(
      (sel: (s: any) => any) =>
        sel({ chatMainSurface: 'chat', setChatMainSurface: vi.fn() }),
      {
        getState: () => ({
          chatMainSurface: 'chat',
          setChatMainSurface: vi.fn(),
        }),
      }
    ),
  };
});

vi.mock('../../../services/toast/ToastContext', () => ({
  toast: { show: vi.fn() },
}));

vi.mock('../../../api/sessionExport', () => ({
  tryDownloadSessionMarkdown: (...args: any[]) =>
    mockTryDownloadSessionMarkdown(...args),
}));

vi.mock('../../../api/conversationRewindApi', () => ({
  previewConversationRewind: (...args: any[]) =>
    mockPreviewConversationRewind(...args),
}));

describe('useChatHandlers & useChatProjectPicker 多分屏天然隔离契约测试 (DIM-02)', () => {
  const sidA = 'session-a';
  const sidB = 'session-b';
  const leafA = 'leaf-a';
  const leafB = 'leaf-b';

  let runStreamingA: ReturnType<typeof vi.fn>;
  let runStreamingB: ReturnType<typeof vi.fn>;
  let setChatInputA: ReturnType<typeof vi.fn>;
  let setChatInputB: ReturnType<typeof vi.fn>;
  let openSidePanelA: ReturnType<typeof vi.fn>;
  let openSidePanelB: ReturnType<typeof vi.fn>;
  let toggleMsgFilterA: ReturnType<typeof vi.fn>;
  let toggleMsgFilterB: ReturnType<typeof vi.fn>;

  let rootElA: HTMLDivElement;
  let rootElB: HTMLDivElement;
  let tiptapElA: HTMLDivElement;
  let tiptapElB: HTMLDivElement;

  const createWrapper = (
    leafId: string,
    sessionId: string,
    isActive: boolean,
    rootEl: HTMLDivElement
  ) => {
    const rootRef = { current: rootEl };
    const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
      <LeafScopeProvider
        leafId={leafId}
        sessionId={sessionId}
        isActive={isActive}
        leafRootRef={rootRef}
      >
        {children}
      </LeafScopeProvider>
    );
    return Wrapper;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState({ activeSessionId: sidA });

    rootElA = document.createElement('div');
    rootElA.setAttribute('data-leaf-id', leafA);
    tiptapElA = document.createElement('div');
    tiptapElA.className = 'tiptap';
    tiptapElA.setAttribute('contenteditable', 'true');
    rootElA.appendChild(tiptapElA);
    document.body.appendChild(rootElA);

    rootElB = document.createElement('div');
    rootElB.setAttribute('data-leaf-id', leafB);
    tiptapElB = document.createElement('div');
    tiptapElB.className = 'tiptap';
    tiptapElB.setAttribute('contenteditable', 'true');
    rootElB.appendChild(tiptapElB);
    document.body.appendChild(rootElB);

    mockSessionsById[sidA] = {
      id: sidA,
      title: '会话 A',
      messages: [
        { id: 'user-a1', sender: 'user', text: '问题 A', timestamp: 1000 },
        { id: 'asst-a1', sender: 'assistant', text: '回答 A', timestamp: 2000 },
      ],
    };

    mockSessionsById[sidB] = {
      id: sidB,
      title: '会话 B',
      messages: [
        { id: 'user-b1', sender: 'user', text: '问题 B', timestamp: 1000 },
        { id: 'asst-b1', sender: 'assistant', text: '回答 B', timestamp: 2000 },
      ],
    };

    runStreamingA = vi.fn();
    runStreamingB = vi.fn();
    setChatInputA = vi.fn();
    setChatInputB = vi.fn();
    openSidePanelA = vi.fn();
    openSidePanelB = vi.fn();
    toggleMsgFilterA = vi.fn();
    toggleMsgFilterB = vi.fn();
  });

  it('1. A-04 (retract-backfill)：向 session-a 派发撤回回填，仅 Pane A 的 setChatInput 被调用，Pane B 草稿纹丝不动', async () => {
    renderHook(
      () =>
        useChatHandlers({
          wsId: 'ws-1',
          activeSessionId: sidA,
          activeSessionTitle: '会话 A',
          handleStopGeneration: vi.fn(),
          setChatInput: setChatInputA,
          runStreamingAssistant: runStreamingA,
        }),
      { wrapper: createWrapper(leafA, sidA, true, rootElA) }
    );

    renderHook(
      () =>
        useChatHandlers({
          wsId: 'ws-1',
          activeSessionId: sidB,
          activeSessionTitle: '会话 B',
          handleStopGeneration: vi.fn(),
          setChatInput: setChatInputB,
          runStreamingAssistant: runStreamingB,
        }),
      { wrapper: createWrapper(leafB, sidB, false, rootElB) }
    );

    await act(async () => {
      emitUiEvent('retract-backfill', {
        sessionId: sidA,
        text: '撤回的原文本 A',
      });
    });

    expect(setChatInputA).toHaveBeenCalledTimes(1);
    expect(setChatInputA).toHaveBeenCalledWith('撤回的原文本 A');
    expect(setChatInputB).not.toHaveBeenCalled();
  });

  it('2. A-05 (retry-failed-turn)：向 session-b 派发失败重试，仅 Pane B 触发 runStreamingAssistant，绝不双窗并发重发', async () => {
    renderHook(
      () =>
        useChatHandlers({
          wsId: 'ws-1',
          activeSessionId: sidA,
          activeSessionTitle: '会话 A',
          handleStopGeneration: vi.fn(),
          setChatInput: setChatInputA,
          runStreamingAssistant: runStreamingA,
        }),
      { wrapper: createWrapper(leafA, sidA, true, rootElA) }
    );

    renderHook(
      () =>
        useChatHandlers({
          wsId: 'ws-1',
          activeSessionId: sidB,
          activeSessionTitle: '会话 B',
          handleStopGeneration: vi.fn(),
          setChatInput: setChatInputB,
          runStreamingAssistant: runStreamingB,
        }),
      { wrapper: createWrapper(leafB, sidB, false, rootElB) }
    );

    await act(async () => {
      emitUiEvent('retry-failed-turn', {
        sessionId: sidB,
        userMsgId: 'user-b1',
        assistantMsgId: 'asst-b1',
      });
    });

    expect(runStreamingA).not.toHaveBeenCalled();
    expect(runStreamingB).toHaveBeenCalledTimes(1);
    expect(runStreamingB).toHaveBeenCalledWith(
      '问题 B',
      'user-b1',
      sidB,
      expect.anything()
    );
  });

  it('3. toggle-msg-filter & open-project-picker：无参全局广播仅由激活分屏消费', async () => {
    const { result: pickerA } = renderHook(
      () => useChatProjectPicker({ activeSessionId: sidA }),
      { wrapper: createWrapper(leafA, sidA, true, rootElA) }
    );

    const { result: pickerB } = renderHook(
      () => useChatProjectPicker({ activeSessionId: sidB }),
      { wrapper: createWrapper(leafB, sidB, false, rootElB) }
    );

    // 触发 open-project-picker（无参广播）
    await act(async () => {
      emitUiEvent('open-project-picker');
    });

    expect(pickerA.current.showProjectPicker).toBe(true);
    expect(pickerB.current.showProjectPicker).toBe(false);

    // 触发 toggle-msg-filter（无参广播）
    await act(async () => {
      emitUiEvent('toggle-msg-filter');
    });

    expect(pickerA.current.showMsgFilter).toBe(true);
    expect(pickerB.current.showMsgFilter).toBe(false);

    // 带目标的 open-project-picker（定址路由至 Pane B）
    await act(async () => {
      emitUiEvent('open-project-picker', { sessionId: sidB });
    });

    expect(pickerB.current.showProjectPicker).toBe(true);
  });

  it('4. export-session-md & open-conversation-rewind：仅目标分屏执行导出与回溯预览', async () => {
    renderHook(
      () =>
        useChatHandlers({
          wsId: 'ws-1',
          activeSessionId: sidA,
          activeSessionTitle: '会话 A',
          handleStopGeneration: vi.fn(),
          setChatInput: setChatInputA,
          runStreamingAssistant: runStreamingA,
        }),
      { wrapper: createWrapper(leafA, sidA, true, rootElA) }
    );

    renderHook(
      () =>
        useChatHandlers({
          wsId: 'ws-1',
          activeSessionId: sidB,
          activeSessionTitle: '会话 B',
          handleStopGeneration: vi.fn(),
          setChatInput: setChatInputB,
          runStreamingAssistant: runStreamingB,
        }),
      { wrapper: createWrapper(leafB, sidB, false, rootElB) }
    );

    // 无参快捷键导出：仅激活分屏 Pane A 导出
    await act(async () => {
      emitUiEvent('export-session-md');
    });

    expect(mockTryDownloadSessionMarkdown).toHaveBeenCalledTimes(1);
    expect(mockTryDownloadSessionMarkdown).toHaveBeenCalledWith(
      mockSessionsById[sidA],
      expect.any(Date),
      expect.anything()
    );

    // 定址导出 Pane B
    await act(async () => {
      emitUiEvent('export-session-md', { sessionId: sidB });
    });

    expect(mockTryDownloadSessionMarkdown).toHaveBeenCalledTimes(2);
    expect(mockTryDownloadSessionMarkdown).toHaveBeenLastCalledWith(
      mockSessionsById[sidB],
      expect.any(Date),
      expect.anything()
    );

    // 无参快捷键回溯预览：仅激活分屏 Pane A 触发
    await act(async () => {
      emitUiEvent('open-conversation-rewind');
    });

    expect(mockPreviewConversationRewind).toHaveBeenCalledTimes(1);
    expect(mockPreviewConversationRewind).toHaveBeenCalledWith({
      sessionId: sidA,
    });
  });

  it('5. C-03 (handleViewPlan)：在非激活分屏 B 调用 handleViewPlan，严格调用 openSidePanel("files", "session-b")', () => {
    const { result: handlersB } = renderHook(
      () =>
        useChatHandlers({
          wsId: 'ws-1',
          activeSessionId: sidB,
          activeSessionTitle: '会话 B',
          handleStopGeneration: vi.fn(),
          setChatInput: setChatInputB,
          runStreamingAssistant: runStreamingB,
          openSidePanel: openSidePanelB,
        }),
      { wrapper: createWrapper(leafB, sidB, false, rootElB) }
    );

    act(() => {
      handlersB.current.handleViewPlan();
    });

    expect(openSidePanelB).toHaveBeenCalledTimes(1);
    expect(openSidePanelB).toHaveBeenCalledWith('files', sidB);
  });

  it('6. D-02 (focus-composer)：在激活分屏 B 触发 focus-composer，精准聚焦分屏 B 内的输入框，不抢分屏 A 的焦点', async () => {
    const focusSpyA = vi.spyOn(tiptapElA, 'focus');
    const focusSpyB = vi.spyOn(tiptapElB, 'focus');

    // 挂载 Pane A 与 Pane B（此时 Pane B 为激活分屏）
    renderHook(() => useChatProjectPicker({ activeSessionId: sidA }), {
      wrapper: createWrapper(leafA, sidA, false, rootElA),
    });

    renderHook(() => useChatProjectPicker({ activeSessionId: sidB }), {
      wrapper: createWrapper(leafB, sidB, true, rootElB),
    });

    await act(async () => {
      emitUiEvent('focus-composer');
      // 等待 requestAnimationFrame 执行
      await new Promise((r) => requestAnimationFrame(r));
    });

    expect(focusSpyA).not.toHaveBeenCalled();
    expect(focusSpyB).toHaveBeenCalledTimes(1);
  });
});
