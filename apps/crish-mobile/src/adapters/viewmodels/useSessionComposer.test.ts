// useSessionComposer 单测（G5b 建档）：纯文本提交回归 + 带附件提交
// （组装透传 / 纯附件不回显 / 超限预检拦截 / 失败返回 false 保留已选区）。
// 仓库经 quickRunWiring 的 getQuickRunContext 注入点替身（requireActual
// 保留错误文案与错误类本体，只替换上下文读取）。
import { act, renderHook } from '@testing-library/react-native';
import { connectionStore } from '@/domain/store/connectionStore';
import { settingsStore } from '@/domain/store/settingsStore';
import type { RunTaskParams } from '@crish/shared-types';
import {
  ATTACHMENT_DATA_URL_MAX_BYTES,
  type ComposerAttachment,
} from '@/domain/pure/attachments';
import { useSessionComposer } from './useSessionComposer';

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

describe('useSessionComposer', () => {
  it('纯文本提交：参数带 sessionId + 权限档，成功回显并清空输入', async () => {
    const onSent = jest.fn();
    const { result } = await renderHook(() =>
      useSessionComposer('s-1', onSent)
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
    expect(onSent).toHaveBeenCalledWith('继续做', 'r-1');
    expect(result.current.prompt).toBe('');
  });

  it('带附件提交：content/hasImages 透传，echo 只回显键入文本', async () => {
    const onSent = jest.fn();
    const { result } = await renderHook(() =>
      useSessionComposer('s-1', onSent)
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
    expect(onSent).toHaveBeenCalledWith('看这张图', 'r-1');
  });

  it('纯附件提交：可发（prompt 为附件块正文），且不产生本地 echo', async () => {
    const onSent = jest.fn();
    const { result } = await renderHook(() =>
      useSessionComposer('s-1', onSent)
    );
    let ok = false;
    await act(async () => {
      ok = await result.current.submitWithAttachments('', [IMAGE_ATT], true);
    });
    expect(ok).toBe(true);
    const params = mockRunTask.mock.calls[0][0] as RunTaskParams;
    expect(params.prompt.startsWith('[附件]\n[图片附件: 截图.png]')).toBe(true);
    expect(onSent).not.toHaveBeenCalled();
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

  it('发送失败：返回 false + 错误反馈（宿主保留已选区）', async () => {
    mockRunTask.mockRejectedValueOnce(new Error('boom'));
    const { result } = await renderHook(() => useSessionComposer('s-1'));
    let ok = true;
    await act(async () => {
      ok = await result.current.submitWithAttachments(
        '看图',
        [IMAGE_ATT],
        true
      );
    });
    expect(ok).toBe(false);
    expect(result.current.feedback.kind).toBe('error');
    expect(result.current.busy).toBe(false);
  });
});
