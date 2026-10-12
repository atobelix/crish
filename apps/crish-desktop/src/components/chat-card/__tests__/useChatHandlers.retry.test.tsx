// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatHandlers } from '../useChatHandlers';
import {
  reportRuntimeStatus,
  useSessionRuntimeStatusStore,
} from '../../../store/sessionRuntimeStatusStore';
import { emitUiEvent } from '../../../api/uiEvents';

const mockWithdrawMessage = vi.fn();
const mockSetSessionMessageStatus = vi.fn();
const mockSessionsById: Record<string, any> = {};
let mockMaxRetries = 10;

vi.mock('../../../app/compositionRoot', () => ({
  getCompositionRoot: () => ({
    session: {
      getState: () => ({
        sessionsById: mockSessionsById,
        withdrawMessage: mockWithdrawMessage,
        setSessionMessageStatus: mockSetSessionMessageStatus,
      }),
    },
  }),
}));

vi.mock('../../../store/storeAccess', async () => {
  const { reportRuntimeStatus } =
    await import('../../../store/sessionRuntimeStatusStore');
  return {
    clearRuntimeStatus: vi.fn(),
    reportRuntimeStatus,
    useSettingsField: (sel: (s: any) => any) =>
      sel({ appSettings: { maxRetryAttempts: mockMaxRetries } }),
  };
});

vi.mock('../../../services/toast/ToastContext', () => ({
  toast: { show: vi.fn() },
}));

describe('useChatHandlers 单次重试上限、设置自由更改与指数退避', () => {
  const sid = 'test-session-1';
  let runStreamingAssistant: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMaxRetries = 10;
    useSessionRuntimeStatusStore.getState().clearAll();
    mockSessionsById[sid] = {
      messages: [
        {
          id: 'user-msg-1',
          sender: 'user',
          text: '请生成代码',
          timestamp: 1000,
        },
        {
          id: 'asst-msg-1',
          sender: 'assistant',
          text: '',
          timestamp: 2000,
        },
      ],
    };
    runStreamingAssistant = vi.fn();
  });

  it('默认单次上限为 10 次，首次重试上报 1/10 进度', async () => {
    renderHook(() =>
      useChatHandlers({
        wsId: 'ws-1',
        activeSessionId: sid,
        activeSessionTitle: '测试会话',
        handleStopGeneration: vi.fn(),
        setChatInput: vi.fn(),
        runStreamingAssistant,
      })
    );

    await act(async () => {
      emitUiEvent('retry-failed-turn', {
        sessionId: sid,
        userMsgId: 'user-msg-1',
        assistantMsgId: 'asst-msg-1',
      });
    });

    expect(runStreamingAssistant).toHaveBeenCalledTimes(1);
    const status = useSessionRuntimeStatusStore.getState().statusBySession[sid];
    expect(status?.phase).toBe('retrying');
    if (status?.phase === 'retrying') {
      expect(status.retry.attempt).toBe(1);
      expect(status.retry.maxAttempts).toBe(10);
    }
  });

  it('设置界面自定义更改为 3 次后上限动态变为 3 次，第 4 次重试被刚性拦截', async () => {
    mockMaxRetries = 3; // 模拟用户在设置界面将数字更改为 3

    renderHook(() =>
      useChatHandlers({
        wsId: 'ws-1',
        activeSessionId: sid,
        activeSessionTitle: '测试会话',
        handleStopGeneration: vi.fn(),
        setChatInput: vi.fn(),
        runStreamingAssistant,
      })
    );

    // 第 1 次重试
    let virtualTime = 10000;
    vi.spyOn(Date, 'now').mockImplementation(() => virtualTime);
    await act(async () => {
      emitUiEvent('retry-failed-turn', {
        sessionId: sid,
        userMsgId: 'user-msg-1',
        assistantMsgId: 'asst-msg-1',
      });
    });
    expect(runStreamingAssistant).toHaveBeenCalledTimes(1);

    // 第 2 次重试（时间推进 2000ms 满足指数退避间隔）
    virtualTime += 2000;
    await act(async () => {
      emitUiEvent('retry-failed-turn', {
        sessionId: sid,
        userMsgId: 'user-msg-1',
        assistantMsgId: 'asst-msg-1',
      });
    });
    expect(runStreamingAssistant).toHaveBeenCalledTimes(2);

    // 第 3 次重试（时间推进 3000ms）
    virtualTime += 3000;
    await act(async () => {
      emitUiEvent('retry-failed-turn', {
        sessionId: sid,
        userMsgId: 'user-msg-1',
        assistantMsgId: 'asst-msg-1',
      });
    });
    expect(runStreamingAssistant).toHaveBeenCalledTimes(3);

    // 第 4 次重试 -> 超出上限 3 次，严禁拉起，转为 failed 状态提示用户
    virtualTime += 5000;
    await act(async () => {
      emitUiEvent('retry-failed-turn', {
        sessionId: sid,
        userMsgId: 'user-msg-1',
        assistantMsgId: 'asst-msg-1',
      });
    });
    // runStreamingAssistant 次数依然为 3，未增加
    expect(runStreamingAssistant).toHaveBeenCalledTimes(3);
    const status = useSessionRuntimeStatusStore.getState().statusBySession[sid];
    expect(status?.phase).toBe('failed');
    if (status?.phase === 'failed') {
      expect(status.message).toContain('已达到最大重试次数上限（3/3 次）');
    }
  });

  it('点击过快时指数退避刚性节流，不重复拉起', async () => {
    renderHook(() =>
      useChatHandlers({
        wsId: 'ws-1',
        activeSessionId: sid,
        activeSessionTitle: '测试会话',
        handleStopGeneration: vi.fn(),
        setChatInput: vi.fn(),
        runStreamingAssistant,
      })
    );

    let virtualTime = 10000;
    vi.spyOn(Date, 'now').mockImplementation(() => virtualTime);

    // 第一次点击
    await act(async () => {
      emitUiEvent('retry-failed-turn', {
        sessionId: sid,
        userMsgId: 'user-msg-1',
        assistantMsgId: 'asst-msg-1',
      });
    });
    expect(runStreamingAssistant).toHaveBeenCalledTimes(1);

    // 立即再次点击（仅过 200ms），低于退避阈值
    virtualTime += 200;
    await act(async () => {
      emitUiEvent('retry-failed-turn', {
        sessionId: sid,
        userMsgId: 'user-msg-1',
        assistantMsgId: 'asst-msg-1',
      });
    });
    // 依然是 1 次，被成功节流
    expect(runStreamingAssistant).toHaveBeenCalledTimes(1);
  });
});
