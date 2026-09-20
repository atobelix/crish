/**
 * useChatStream onRunError 单轨分发端到端测试（docs/chat-notice-convergence §2.0/§2.3）：
 * - 全部终态错误（含 network）唯一承载体 = SessionRuntimeStatusStore failed 相位；
 * - 不写 toast、不写横幅、不写气泡 errorDetail；
 * - 有正文保留并置 error（流内「回复中断」事实标记）；无正文 withdraw 占位；user 消息收 completed；
 * - transport 恢复：network 类失败「恢复即消失」。
 */
// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStream } from './index';
import { useSessionRuntimeStatusStore } from '../../store/sessionRuntimeStatusStore';
import type { UseChatStreamOptions } from './types';

const h = vi.hoisted(() => {
  const transport = {
    onStatus: vi.fn(() => () => {}),
    isReady: vi.fn(() => false),
    waitUntilConnected: vi.fn(() => Promise.resolve(false)),
    onMessage: vi.fn(),
    invoke: vi.fn(),
  };
  return {
    transport,
    streamAssistantResponseApi: vi.fn(() => () => {}),
    layoutState: {
      addMessage: vi.fn(),
      withdrawMessage: vi.fn(),
      setSessionMessageStatus: vi.fn(),
      updateMessageThinking: vi.fn(),
      updateMessageToolCall: vi.fn(),
      updateMessageText: vi.fn(),
    },
    getSessionById: vi.fn(),
  };
});

vi.mock('../../api/transport', () => ({
  getTransport: () => h.transport,
}));
vi.mock('../../api/chatApi', () => ({
  streamAssistantResponseApi: h.streamAssistantResponseApi,
}));
vi.mock('../../app/compositionRoot', () => ({
  getCompositionRoot: () => ({
    session: {
      getActiveSessionId: () => 'sess-1',
      getState: () => ({
        getSessionById: h.getSessionById,
        ...h.layoutState,
      }),
    },
    layout: { getState: () => h.layoutState },
    runControl: { dispatch: vi.fn() },
  }),
}));
vi.mock('../../store/sessionStore', () => ({
  getSessionById: h.getSessionById,
  useSessionStore: vi.fn((selector) =>
    typeof selector === 'function'
      ? selector({ upsertSessionAgent: vi.fn() })
      : {}
  ),
}));

vi.mock('../../services/toast/ToastContext', () => ({
  toast: {
    show: (msg: string) => showToastMock(msg),
    error: (msg: string) => showToastMock(msg),
  },
}));

const showToastMock = vi.fn();

const mockOptions: UseChatStreamOptions = {
  wsId: 'ws-test',
  onShowToast: showToastMock,
  handleGlobalTabClick: vi.fn(),
  chatInput: '',
  setChatInput: vi.fn(),
  setSlashMenuOpen: vi.fn(),
  attachments: [],
  setAttachments: vi.fn(),
  skillCommandsEnabled: true,
  needsKeySetup: false,
  setPickerInlineError: vi.fn(),
};

function makeSession(messages: Array<Record<string, unknown>> = []) {
  return { id: 'sess-1', goalMode: null, agents: [], messages };
}


describe('useChatStream onRunError 单轨分发（端到端，docs/chat-notice-convergence §2.0）', () => {
  beforeEach(() => {
    showToastMock.mockClear();
    h.layoutState.addMessage.mockClear();
    h.layoutState.withdrawMessage.mockClear();
    h.layoutState.setSessionMessageStatus.mockClear();
    h.streamAssistantResponseApi.mockClear();
    h.transport.onStatus.mockClear();
    h.transport.onMessage.mockClear();
    h.getSessionById.mockReturnValue(makeSession());
    useSessionRuntimeStatusStore.getState().clearAll();
  });

  /** 读取状态机相位（无则 null） */
  function runtimePhase(sid = 'sess-1') {
    return (
      useSessionRuntimeStatusStore.getState().statusBySession[sid]?.phase ?? null
    );
  }

  /** 启动一个 run 并返回捕获的 onRunError 回调（含生成的 assistant 占位消息） */
  function startRunAndGetErrorHandler() {
    const { result } = renderHook(() => useChatStream(mockOptions));
    act(() => {
      result.current.runStreamingAssistant('你好', 'user-1', 'sess-1');
    });
    const callbacks = h.streamAssistantResponseApi.mock.calls[0]?.[1] as {
      onRunError: (
        message: string,
        kind?: string,
        detail?: unknown
      ) => void;
    };
    const addedMsg = h.layoutState.addMessage.mock.calls[0]?.[2] as {
      id: string;
    };
    return { result, callbacks, addedMsg };
  }

  it('network 无正文：状态机 failed（唯一承载体），无 toast/无气泡，withdraw 占位；恢复即消失', () => {
    const { callbacks, addedMsg } = startRunAndGetErrorHandler();
    h.getSessionById.mockReturnValue(
      makeSession([
        {
          id: addedMsg.id,
          sender: 'assistant',
          text: '',
          status: 'processing',
          toolCalls: [],
        },
      ])
    );

    act(() => {
      callbacks.onRunError(
        '服务暂时不可用，正在自动恢复，请稍后再试。',
        'network'
      );
    });

    expect(showToastMock).not.toHaveBeenCalled(); // network 不进 toast
    expect(h.layoutState.withdrawMessage).toHaveBeenCalledWith(
      'ws-test',
      'sess-1',
      addedMsg.id
    );
    expect(h.layoutState.setSessionMessageStatus).not.toHaveBeenCalled(); // 不写气泡
    expect(runtimePhase()).toBe('failed'); // 唯一承载体：状态机
    const st = useSessionRuntimeStatusStore.getState().statusBySession['sess-1'];
    if (st?.phase === 'failed') expect(st.kind).toBe('network');

    // 恢复即消失：transport connected → network 类失败自动清空
    const statusListener = h.transport.onStatus.mock.calls[0]?.[0] as (
      s: string
    ) => void;
    act(() => {
      statusListener('connected');
    });
    expect(runtimePhase()).toBeNull();
  });

  it('network 有正文：保留正文并置 error，user 收 completed，状态机 failed（不 withdraw）', () => {
    const { callbacks, addedMsg } = startRunAndGetErrorHandler();
    h.getSessionById.mockReturnValue(
      makeSession([
        {
          id: addedMsg.id,
          sender: 'assistant',
          text: '已有正文',
          status: 'processing',
          toolCalls: [],
        },
      ])
    );

    act(() => {
      callbacks.onRunError('服务暂时不可用，正在自动恢复，请稍后再试。', 'network');
    });

    expect(h.layoutState.withdrawMessage).not.toHaveBeenCalled();
    expect(h.layoutState.setSessionMessageStatus).toHaveBeenCalledWith(
      'sess-1',
      addedMsg.id,
      'error'
    );
    expect(runtimePhase()).toBe('failed');
  });

  it('有正文失败（非 network）：仅状态机 failed 相位，不弹横幅/toast；正文保留置 error，turn 定位 user/assistant', () => {
    const { result, callbacks, addedMsg } = startRunAndGetErrorHandler();
    h.getSessionById.mockReturnValue(
      makeSession([
        {
          id: addedMsg.id,
          sender: 'assistant',
          text: '正文内容',
          status: 'processing',
          toolCalls: [],
        },
      ])
    );

    act(() => {
      callbacks.onRunError('这一轮任务中断了，请稍后重试。', 'ended');
    });

    expect(showToastMock).not.toHaveBeenCalled(); // 不弹 toast
    expect(h.layoutState.withdrawMessage).not.toHaveBeenCalled(); // 正文保留
    // 有正文：置 error（事实记录；不再写 errorDetail 气泡错误卡）
    expect(h.layoutState.setSessionMessageStatus).toHaveBeenCalledWith(
      'sess-1',
      addedMsg.id,
      'error'
    );
    // 错误唯一承载体：状态机 failed 相位，只带消息定位、不缓存提问文本
    const status = useSessionRuntimeStatusStore.getState().statusBySession['sess-1'];
    expect(status?.phase).toBe('failed');
    if (status?.phase === 'failed') {
      expect(status.message).toBe('这一轮任务中断了，请稍后重试。');
      expect(status.kind).toBe('generic');
      expect(status.turn).toEqual({ userMsgId: 'user-1', assistantMsgId: addedMsg.id });
      expect('promptText' in status).toBe(false);
    }
  });

  it('错误即本轮终态：processing 的 user 消息收 completed（发送按钮不被 Stop 常驻）', () => {
    const { callbacks, addedMsg } = startRunAndGetErrorHandler();
    h.getSessionById.mockReturnValue(
      makeSession([
        { id: 'user-1', sender: 'user', text: '你好', status: 'processing' },
        { id: addedMsg.id, sender: 'assistant', text: '', status: 'processing', toolCalls: [] },
      ])
    );

    act(() => {
      callbacks.onRunError('服务端错误', 'server_error');
    });

    expect(h.layoutState.setSessionMessageStatus).toHaveBeenCalledWith(
      'sess-1',
      'user-1',
      'completed'
    );
  });

  it('无正文失败（非 network）：withdraw 占位 + 状态机 failed，无横幅/无 toast', () => {
    const { result, callbacks, addedMsg } = startRunAndGetErrorHandler();
    h.getSessionById.mockReturnValue(
      makeSession([
        {
          id: addedMsg.id,
          sender: 'assistant',
          text: '',
          status: 'processing',
          toolCalls: [],
        },
      ])
    );

    act(() => {
      callbacks.onRunError('这一轮任务中断了，请稍后重试。', 'ended');
    });

    expect(showToastMock).not.toHaveBeenCalled(); // 无 toast
    expect(h.layoutState.withdrawMessage).toHaveBeenCalled();
    expect(h.layoutState.setSessionMessageStatus).not.toHaveBeenCalled();
    expect(runtimePhase()).toBe('failed');
  });

  it('可行动错误（blocked）：仅状态机 failed，无横幅、无 toast（双显已废除）', () => {
    const { result, callbacks } = startRunAndGetErrorHandler();

    act(() => {
      callbacks.onRunError('该操作未获允许（可能被安全策略或计划模式拦截）。', 'blocked');
    });

    expect(showToastMock).not.toHaveBeenCalled();
    const status = useSessionRuntimeStatusStore.getState().statusBySession['sess-1'];
    expect(status?.phase).toBe('failed');
    if (status?.phase === 'failed') {
      expect(status.kind).toBe('generic'); // blocked 不在状态机 kind 枚举内 → generic
      expect(status.message).toBe(
        '该操作未获允许（可能被安全策略或计划模式拦截）。'
      );
    }
  });
});
