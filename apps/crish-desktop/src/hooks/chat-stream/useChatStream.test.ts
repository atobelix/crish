/**
 * useChatStream 横幅控制器与分级分发端到端测试：
 * - createRunNoticeController：同文案去重窗口 / persistent 变体 / dismissTransient；
 * - useChatStream × transport onStatus：network 持久条「恢复即消失」；
 * - onRunError 分级分发（network 仅持久条 / 有正文仅气泡 / 无正文仅横幅 / 可行动横幅+toast）。
 */
// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRunNoticeController,
  normalizeRunNoticeKey,
  RUN_NOTICE_DEDUPE_WINDOW_MS,
  useChatStream,
} from './index';
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
    session: { getActiveSessionId: () => 'sess-1' },
    layout: { getState: () => h.layoutState },
    runControl: { dispatch: vi.fn() },
  }),
}));
vi.mock('../../store/sessionStore', () => ({
  getSessionById: h.getSessionById,
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

describe('createRunNoticeController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('普通 push：显示 + TTL 到期自动消失', () => {
    const set = vi.fn();
    const c = createRunNoticeController(set);
    c.push({ text: '横幅A' }, 8000);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ text: '横幅A' }));
    vi.advanceTimersByTime(8000);
    expect(set).toHaveBeenLastCalledWith(null);
  });

  it('同文案窗口内（可见）重复 push：不重复 set，仅刷新 TTL', () => {
    const set = vi.fn();
    let now = 1000;
    const c = createRunNoticeController(set, () => now);
    c.push({ text: '横幅A' }, 8000);
    expect(set).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4000);
    now = 5000;
    c.push({ text: '横幅A' }, 8000);
    expect(set).toHaveBeenCalledTimes(1); // 同文案不叠层、不重显
    vi.advanceTimersByTime(8000); // 刷新后的 TTL 到期
    expect(set).toHaveBeenLastCalledWith(null);
  });

  it('同文案窗口内（已消失）重复 push：抑制不重显', () => {
    const set = vi.fn();
    let now = 1000;
    const c = createRunNoticeController(set, () => now);
    c.push({ text: '横幅A' }, 8000);
    vi.advanceTimersByTime(8000); // TTL 到期消失
    set.mockClear();
    now = 1000 + RUN_NOTICE_DEDUPE_WINDOW_MS - 1; // 仍在 30s 窗口内
    c.push({ text: '横幅A' }, 8000);
    expect(set).not.toHaveBeenCalled(); // 抑制，不重显
  });

  it('窗口外同文案：重新显示', () => {
    const set = vi.fn();
    let now = 1000;
    const c = createRunNoticeController(set, () => now);
    c.push({ text: '横幅A' }, 8000);
    vi.advanceTimersByTime(8000);
    set.mockClear();
    now = 1000 + RUN_NOTICE_DEDUPE_WINDOW_MS + 1; // 窗口过期
    c.push({ text: '横幅A' }, 8000);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ text: '横幅A' }));
  });

  it('persistent push：无 TTL，推进时间不消失', () => {
    const set = vi.fn();
    const c = createRunNoticeController(set);
    c.push({ text: '服务暂时不可用', kind: 'network', persistent: true });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ persistent: true })
    );
    vi.advanceTimersByTime(120_000);
    expect(set).not.toHaveBeenLastCalledWith(null);
  });

  it('persistent 同文案重复 push：幂等保持，不重复 set', () => {
    const set = vi.fn();
    const c = createRunNoticeController(set);
    c.push({ text: '服务暂时不可用', persistent: true });
    expect(set).toHaveBeenCalledTimes(1);
    c.push({ text: '服务暂时不可用', persistent: true });
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('dismissTransient：持久条显示中保持，TTL 横幅显示中清除', () => {
    const set = vi.fn();
    const c = createRunNoticeController(set);
    c.push({ text: '服务暂时不可用', persistent: true });
    set.mockClear();
    c.dismissTransient();
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ text: '服务暂时不可用', persistent: true })
    );
    c.push({ text: '临时横幅B' }, 8000); // TTL 横幅覆盖持久条
    set.mockClear();
    c.dismissTransient();
    expect(set).toHaveBeenCalledWith(null);
  });

  it('dismiss：全清（含持久条）并重置去重窗口', () => {
    const set = vi.fn();
    const c = createRunNoticeController(set);
    c.push({ text: '服务暂时不可用', persistent: true });
    set.mockClear();
    c.dismiss();
    expect(set).toHaveBeenCalledWith(null);
    // 重置后同文案可立即重新 push（手动关闭后不抑制）
    c.push({ text: '服务暂时不可用', persistent: true });
    expect(set).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: '服务暂时不可用', persistent: true })
    );
  });

  it('dispose：清理 TTL timer，不再自动消失回调', () => {
    const set = vi.fn();
    const c = createRunNoticeController(set);
    c.push({ text: '横幅A' }, 8000);
    c.dispose();
    vi.advanceTimersByTime(10_000);
    expect(set).toHaveBeenCalledTimes(1); // 仅初次显示，无消失回调
  });

  it('normalizeRunNoticeKey：trim 归一（对齐 toast dedupe）', () => {
    expect(normalizeRunNoticeKey('  x ')).toBe('x');
    expect(normalizeRunNoticeKey('')).toBe('');
  });
});

describe('useChatStream onRunError 分级分发（端到端）', () => {
  beforeEach(() => {
    showToastMock.mockClear();
    h.layoutState.addMessage.mockClear();
    h.layoutState.withdrawMessage.mockClear();
    h.layoutState.setSessionMessageStatus.mockClear();
    h.streamAssistantResponseApi.mockClear();
    h.transport.onStatus.mockClear();
    h.transport.onMessage.mockClear();
    h.getSessionById.mockReturnValue(makeSession());
  });

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

  it('network：仅持久条，无 toast；无正文 withdraw 占位；transport connected 恢复即消失', () => {
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
      callbacks.onRunError(
        '服务暂时不可用，正在自动恢复，请稍后再试。',
        'network'
      );
    });

    expect(result.current.runNotice).toMatchObject({
      text: '服务暂时不可用，正在自动恢复，请稍后再试。',
      persistent: true,
    });
    expect(showToastMock).not.toHaveBeenCalled(); // network 不进 toast
    expect(h.layoutState.withdrawMessage).toHaveBeenCalledWith(
      'ws-test',
      'sess-1',
      addedMsg.id
    );
    expect(h.layoutState.setSessionMessageStatus).not.toHaveBeenCalled(); // 不写气泡

    // 恢复即消失：transport failed/connecting → connected 切换点
    const statusListener = h.transport.onStatus.mock.calls[0]?.[0] as (
      s: string
    ) => void;
    act(() => {
      statusListener('connected');
    });
    expect(result.current.runNotice).toBeNull();
  });

  it('network 有正文：不写气泡错误卡、不 withdraw（保留正文）', () => {
    const { result, callbacks, addedMsg } = startRunAndGetErrorHandler();
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

    expect(result.current.runNotice).toMatchObject({ persistent: true });
    expect(h.layoutState.withdrawMessage).not.toHaveBeenCalled();
    expect(h.layoutState.setSessionMessageStatus).not.toHaveBeenCalled();
  });

  it('有正文失败（非 network 非可行动）：仅气泡错误卡，不弹横幅、不弹 toast', () => {
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

    expect(result.current.runNotice).toBeNull(); // 不弹横幅
    expect(showToastMock).not.toHaveBeenCalled(); // 不弹 toast
    expect(h.layoutState.setSessionMessageStatus).toHaveBeenCalledWith(
      'sess-1',
      addedMsg.id,
      'error',
      undefined,
      expect.objectContaining({
        errorDetail: expect.objectContaining({
          message: '这一轮任务中断了，请稍后重试。',
          kind: 'ended',
        }),
      })
    );
  });

  it('无正文失败（非 network 非可行动）：仅横幅，无 toast，withdraw 占位', () => {
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

    expect(result.current.runNotice).toMatchObject({
      text: '这一轮任务中断了，请稍后重试。',
    });
    expect(result.current.runNotice?.persistent).toBeUndefined();
    expect(showToastMock).not.toHaveBeenCalled(); // 无 toast
    expect(h.layoutState.withdrawMessage).toHaveBeenCalled();
    expect(h.layoutState.setSessionMessageStatus).not.toHaveBeenCalled();
  });

  it('可行动错误（blocked）：横幅 + 一次性 toast', () => {
    const { result, callbacks } = startRunAndGetErrorHandler();

    act(() => {
      callbacks.onRunError('该操作未获允许（可能被安全策略或计划模式拦截）。', 'blocked');
    });

    expect(result.current.runNotice).toMatchObject({
      text: '该操作未获允许（可能被安全策略或计划模式拦截）。',
    });
    expect(result.current.runNotice?.persistent).toBeUndefined();
    expect(showToastMock).toHaveBeenCalledWith(
      '该操作未获允许（可能被安全策略或计划模式拦截）。'
    );
  });
});
