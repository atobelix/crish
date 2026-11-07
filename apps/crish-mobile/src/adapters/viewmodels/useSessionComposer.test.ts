// useSessionComposer 单测（G5b 建档 + R5 受理/ACK 分离）：纯文本提交回归 +
// 带附件提交（组装透传 / 纯附件不回显 / 超限预检拦截 / 失败恢复）。
// R5 必测：延迟 Promise 下立即 pending 和清稿、reject 恢复/新稿保留、附件、
// 重复点互斥、卸载迟到回调、成功 ACK 关联真 ID。
// 仓库经 quickRunWiring 的 getQuickRunContext 注入点替身（requireActual
// 保留错误文案与错误类本体，只替换上下文读取）。
import { act, renderHook } from '@testing-library/react-native';
import { connectionStore } from '@/domain/store/connectionStore';
import { settingsStore } from '@/domain/store/settingsStore';
import { haptics } from '@/adapters/platform/haptics';
import type { RunTaskParams } from '@crish/shared-types';
import {
  ATTACHMENT_DATA_URL_MAX_BYTES,
  type ComposerAttachment,
} from '@/domain/pure/attachments';
import {
  useSessionComposer,
  type SessionComposerSend,
} from './useSessionComposer';

const mockRunTask = jest.fn();

jest.mock('@/adapters/RemoteControlFacade', () => {
  const actual = jest.requireActual('@/adapters/RemoteControlFacade');
  return {
    ...actual,
    getQuickRunContext: () => ({ repository: { runTask: mockRunTask } }),
    remoteControlFacade: {
      ...actual.remoteControlFacade,
      isAvailable: () => true,
      runTask: mockRunTask,
    },
  };
});

const IMAGE_ATT: ComposerAttachment = {
  id: 'a-1',
  name: '截图.png',
  kind: 'image',
  dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  sizeBytes: 1024,
  mime: 'image/png',
};

beforeEach(() => {
  connectionStore.setState({ phase: 'ready' });
  settingsStore.setState((s) => ({
    groups: { ...s.groups, composer: { permissionMode: 'smart' as const } },
  }));
  mockRunTask.mockReset();
  mockRunTask.mockResolvedValue({ runId: 'r-1', sessionId: 's-1' });
});

describe('useSessionComposer（既有回归，R5 回调组口径）', () => {
  it('纯文本提交：参数带 sessionId + 权限档，ACK 回调携带真实 runId 且输入清空', async () => {
    const send: SessionComposerSend = {
      onPending: jest.fn(),
      onAcked: jest.fn(),
      onFailed: jest.fn(),
    };
    const { result } = await renderHook(() =>
      useSessionComposer('s-1', send)
    );
    await act(async () => {
      result.current.setPrompt('继续做');
    });
    let ok = false;
    await act(async () => {
      ok = await result.current.submit();
    });
    expect(ok).toBe(true);
    expect(mockRunTask).toHaveBeenCalledWith({
      prompt: '继续做',
      sessionId: 's-1',
      permissionMode: 'smart',
    });
    expect(send.onAcked).toHaveBeenCalledWith('pending-1', 'r-1', undefined);
    expect(result.current.prompt).toBe('');
  });

  it('带附件提交：content/hasImages 透传，onPending 回显键入文本', async () => {
    const send: SessionComposerSend = {
      onPending: jest.fn(),
      onAcked: jest.fn(),
    };
    const { result } = await renderHook(() =>
      useSessionComposer('s-1', send)
    );
    await act(async () => {
      result.current.setPrompt('看这张图');
    });
    let ok = false;
    await act(async () => {
      ok = await result.current.submitWithAttachments(
        result.current.prompt,
        [IMAGE_ATT],
        true
      );
    });
    expect(ok).toBe(true);
    const params = mockRunTask.mock.calls[0][0] as RunTaskParams;
    expect(params.sessionId).toBe('s-1');
    expect(params.hasImages).toBe(true);
    expect(params.prompt).toContain('[图片附件: 截图.png]');
    expect(send.onPending).toHaveBeenCalledWith('pending-1', '看这张图');
    expect(send.onAcked).toHaveBeenCalledWith('pending-1', 'r-1', undefined);
  });

  it('纯附件提交：可发（prompt 为附件块正文），onPending 回显空文本', async () => {
    const send: SessionComposerSend = { onPending: jest.fn(), onAcked: jest.fn() };
    const { result } = await renderHook(() =>
      useSessionComposer('s-1', send)
    );
    let ok = false;
    await act(async () => {
      ok = await result.current.submitWithAttachments('', [IMAGE_ATT], true);
    });
    expect(ok).toBe(true);
    const params = mockRunTask.mock.calls[0][0] as RunTaskParams;
    expect(params.prompt.startsWith('[附件]\n[图片附件: 截图.png]')).toBe(true);
    expect(send.onPending).toHaveBeenCalledWith('pending-1', '');
  });

  it('非视觉降级：hasImages=false，content 不含 dataUrl', async () => {
    const { result } = await renderHook(() => useSessionComposer('s-1'));
    let ok = false;
    await act(async () => {
      ok = await result.current.submitWithAttachments(
        '看图',
        [IMAGE_ATT],
        false
      );
    });
    expect(ok).toBe(true);
    const params = mockRunTask.mock.calls[0][0] as RunTaskParams;
    expect(params.hasImages).toBe(false);
    expect(JSON.stringify(params.content)).not.toContain('data:image');
  });

  it('超限预检：仓库不被调用，返回 false 并落错误反馈（已选区保留依据）', async () => {
    const { result } = await renderHook(() => useSessionComposer('s-1'));
    const big: ComposerAttachment = {
      ...IMAGE_ATT,
      dataUrl: `data:image/jpeg;base64,${'A'.repeat(ATTACHMENT_DATA_URL_MAX_BYTES)}`,
    };
    let ok = true;
    await act(async () => {
      ok = await result.current.submitWithAttachments('看图', [big], true);
    });
    expect(ok).toBe(false);
    expect(mockRunTask).not.toHaveBeenCalled();
    expect(result.current.feedback.kind).toBe('error');
    expect(result.current.feedback.message).toContain('截图.png');
  });
});

describe('useSessionComposer R5：受理与 ACK 分离', () => {
  it('延迟 Promise 下受理即清稿 + 立即 pending（早于 ACK）', async () => {
    let resolveRunner!: (v: { runId: string; sessionId?: string }) => void;
    mockRunTask.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRunner = resolve;
        })
    );
    const send: SessionComposerSend = {
      onPending: jest.fn(),
      onAcked: jest.fn(),
    };
    const { result } = await renderHook(() =>
      useSessionComposer('s-1', send)
    );
    await act(async () => {
      result.current.setPrompt('等待中的稿');
    });
    let submitPromise!: Promise<boolean>;
    await act(async () => {
      submitPromise = result.current.submit();
    });
    // 受理即返回 true、清稿、pending 回显；此时仓储尚未回执
    expect(send.onPending).toHaveBeenCalledTimes(1);
    expect(send.onPending).toHaveBeenCalledWith('pending-1', '等待中的稿');
    expect(send.onAcked).not.toHaveBeenCalled();
    expect(result.current.prompt).toBe('');
    expect(result.current.busy).toBe(true);
    expect(result.current.feedback.kind).toBe('sending');

    let ok = false;
    await act(async () => {
      resolveRunner({ runId: 'r-real-9' });
      ok = await submitPromise;
    });
    expect(ok).toBe(true);
    // ACK 关联真实回执 id（不伪造）
    expect(send.onAcked).toHaveBeenCalledWith('pending-1', 'r-real-9', undefined);
    expect(result.current.busy).toBe(false);
    expect(result.current.feedback.kind).toBe('success');
  });

  it('重复点击互斥：等待期间二次提交被拒（不重复发送）', async () => {
    let resolveRunner!: (v: { runId: string }) => void;
    mockRunTask.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRunner = resolve;
        })
    );
    const { result } = await renderHook(() => useSessionComposer('s-1'));
    await act(async () => {
      result.current.setPrompt('第一条');
    });
    let submitPromise!: Promise<boolean>;
    await act(async () => {
      submitPromise = result.current.submit();
    });
    let second = true;
    await act(async () => {
      result.current.setPrompt('第二条');
      second = await result.current.submit();
    });
    expect(second).toBe(false);
    expect(mockRunTask).toHaveBeenCalledTimes(1);
    let first = false;
    await act(async () => {
      resolveRunner({ runId: 'r-1' });
      first = await submitPromise;
    });
    expect(first).toBe(true);
  });

  it('reject 且输入未被新写：快照恢复进输入框，onFailed 标记 restoredToInput', async () => {
    mockRunTask.mockRejectedValueOnce(new Error('boom'));
    const send: SessionComposerSend = {
      onPending: jest.fn(),
      onFailed: jest.fn(),
    };
    const { result } = await renderHook(() =>
      useSessionComposer('s-1', send)
    );
    await act(async () => {
      result.current.setPrompt('要恢复的稿');
    });
    let ok = true;
    await act(async () => {
      ok = await result.current.submit();
    });
    expect(ok).toBe(false);
    // 快照回到输入框，可重试
    expect(result.current.prompt).toBe('要恢复的稿');
    expect(result.current.feedback.kind).toBe('error');
    expect(result.current.busy).toBe(false);
    expect(send.onFailed).toHaveBeenCalledWith('pending-1', {
      restoredToInput: true,
      text: '要恢复的稿',
      attachments: [],
    });
  });

  it('reject 且等待期间用户新写：新稿保留不被快照覆盖，onFailed 携带附件快照', async () => {
    let rejectRunner!: (e: unknown) => void;
    mockRunTask.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRunner = reject;
        })
    );
    const send: SessionComposerSend = {
      onPending: jest.fn(),
      onFailed: jest.fn(),
    };
    const { result } = await renderHook(() =>
      useSessionComposer('s-1', send)
    );
    await act(async () => {
      result.current.setPrompt('旧稿');
    });
    let submitPromise!: Promise<boolean>;
    await act(async () => {
      submitPromise = result.current.submitWithAttachments(
        '旧稿',
        [IMAGE_ATT],
        true
      );
    });
    // 等待期间用户写新稿
    await act(async () => {
      result.current.setPrompt('等待期间的新稿');
    });
    let ok = true;
    await act(async () => {
      rejectRunner(new Error('boom'));
      ok = await submitPromise;
    });
    expect(ok).toBe(false);
    // 新稿原样保留，不被旧快照覆盖
    expect(result.current.prompt).toBe('等待期间的新稿');
    expect(result.current.feedback.kind).toBe('error');
    expect(send.onFailed).toHaveBeenCalledWith('pending-1', {
      restoredToInput: false,
      text: '旧稿',
      attachments: [IMAGE_ATT],
    });
  });

  it('草稿路径 ACK：createdSessionId 经 onAcked 与 onSessionCreated 送达', async () => {
    mockRunTask.mockResolvedValueOnce({ runId: 'r-2', sessionId: 's-new' });
    const send: SessionComposerSend = {
      onAcked: jest.fn(),
      onSessionCreated: jest.fn(),
    };
    const { result } = await renderHook(() =>
      useSessionComposer(null, send)
    );
    await act(async () => {
      result.current.setPrompt('首条消息');
    });
    await act(async () => {
      await result.current.submit();
    });
    expect(send.onAcked).toHaveBeenCalledWith('pending-1', 'r-2', 's-new');
    expect(send.onSessionCreated).toHaveBeenCalledWith('s-new');
  });

  it('卸载后迟到回执：不再触碰状态面（无告警、无崩溃）', async () => {
    let resolveRunner!: (v: { runId: string }) => void;
    mockRunTask.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRunner = resolve;
        })
    );
    const { result, unmount } = await renderHook(() =>
      useSessionComposer('s-1')
    );
    await act(async () => {
      result.current.setPrompt('卸载前的稿');
    });
    let submitPromise!: Promise<boolean>;
    await act(async () => {
      submitPromise = result.current.submit();
    });
    unmount();
    // 卸载后不再进 act（渲染器已死；aliveRef 守卫保证结算路径无 setState）
    resolveRunner({ runId: 'r-late' });
    await submitPromise;
    // 无崩溃即通过（状态面已随卸载失效）
  });
});

describe('useSessionComposer R6：发送只震一次', () => {
  it('受理 tap 恰一次，ACK 不叠加 success，失败叠加 failure 恰一次', async () => {
    const tapSpy = jest.spyOn(haptics, 'tap');
    const successSpy = jest.spyOn(haptics, 'success');
    const failureSpy = jest.spyOn(haptics, 'failure');
    const { result } = await renderHook(() => useSessionComposer('s-1'));
    await act(async () => {
      result.current.setPrompt('触觉一次的稿');
    });
    // 成功路径：受理 tap 一次，无 success/failure
    await act(async () => {
      await result.current.submit();
    });
    expect(tapSpy).toHaveBeenCalledTimes(1);
    expect(successSpy).not.toHaveBeenCalled();
    expect(failureSpy).not.toHaveBeenCalled();

    // 失败路径：受理 tap 一次 + 失败 failure 一次，无 success
    mockRunTask.mockRejectedValueOnce(new Error('boom'));
    await act(async () => {
      result.current.setPrompt('失败的稿');
    });
    tapSpy.mockClear();
    await act(async () => {
      await result.current.submit();
    });
    expect(tapSpy).toHaveBeenCalledTimes(1);
    expect(failureSpy).toHaveBeenCalledTimes(1);
    expect(successSpy).not.toHaveBeenCalled();

    tapSpy.mockRestore();
    successSpy.mockRestore();
    failureSpy.mockRestore();
  });
});
