// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useNativeInspectorBridge } from './useNativeInspectorBridge';
import type { NativeBrowserInspectorEvent } from './nativeBrowserInspectorApi';

const { setInspectorMock, subscribeMock, toastErrorMock } = vi.hoisted(() => ({
  setInspectorMock: vi.fn(),
  subscribeMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock('./nativeBrowserInspectorApi', () => ({
  browserWebviewSetInspector: setInspectorMock,
  onNativeBrowserInspectorEvent: subscribeMock,
}));
vi.mock('../../services/toast/ToastContext', () => ({
  toast: { error: toastErrorMock },
}));

describe('useNativeInspectorBridge', () => {
  let listener: ((event: NativeBrowserInspectorEvent) => void) | null;
  const unsubscribe = vi.fn();
  const tabId = 'browser-leaf-inspector';

  beforeEach(() => {
    vi.clearAllMocks();
    listener = null;
    setInspectorMock.mockResolvedValue(undefined);
    subscribeMock.mockImplementation((callback, observer) => {
      listener = callback;
      observer?.onReady?.();
      return unsubscribe;
    });
  });

  it('切换命令驱动 active 状态并清除 hover', async () => {
    const { result } = renderHook(() => useNativeInspectorBridge(tabId));
    await waitFor(() => expect(result.current.canToggle).toBe(true));

    act(() => result.current.toggle());
    expect(result.current.isActive).toBe(true);
    await waitFor(() =>
      expect(setInspectorMock).toHaveBeenCalledWith(tabId, true)
    );

    act(() => {
      listener?.({
        tabId,
        type: 'INSPECT_HOVER',
        payload: {
          tagName: 'button',
          selector: 'button.primary',
          rect: { x: 0, y: 0, width: 20, height: 10 },
        },
      });
    });
    expect(result.current.hoverElement?.selector).toBe('button.primary');

    act(() => result.current.toggle());
    expect(result.current.isActive).toBe(false);
    expect(result.current.hoverElement).toBeNull();
    await waitFor(() =>
      expect(setInspectorMock).toHaveBeenLastCalledWith(tabId, false)
    );
  });

  it('启停失败回滚 optimistic active 状态并通知用户', async () => {
    setInspectorMock.mockRejectedValueOnce(new Error('native command failed'));
    const { result } = renderHook(() => useNativeInspectorBridge(tabId));
    await waitFor(() => expect(result.current.canToggle).toBe(true));

    act(() => result.current.toggle());
    expect(result.current.isActive).toBe(true);
    await waitFor(() => expect(result.current.isActive).toBe(false));
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining('native command failed')
    );
  });

  it('Native Webview 不可用时重置 active，且未知 tab 清理错误不误报', async () => {
    const { result, rerender } = renderHook(
      ({ available }) => useNativeInspectorBridge(tabId, available),
      { initialProps: { available: true } }
    );
    await waitFor(() => expect(result.current.canToggle).toBe(true));
    act(() => result.current.toggle());
    await waitFor(() => expect(setInspectorMock).toHaveBeenCalledTimes(1));

    setInspectorMock.mockRejectedValueOnce(
      new Error(`Webview not found: ${tabId}`)
    );
    rerender({ available: false });

    expect(result.current.isActive).toBe(false);
    await waitFor(() => expect(setInspectorMock).toHaveBeenCalledTimes(2));
    expect(setInspectorMock).toHaveBeenLastCalledWith(tabId, false);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('不可用空白页卸载不会发送无效 stop 命令', () => {
    const { result, unmount } = renderHook(() =>
      useNativeInspectorBridge(tabId, false)
    );
    act(() => result.current.toggle());
    expect(result.current.isActive).toBe(false);
    unmount();
    expect(setInspectorMock).not.toHaveBeenCalled();
  });

  it('导航期间禁止新启用，READY 后恢复 inactive 拾取器按钮', async () => {
    const { result, rerender } = renderHook(
      ({ navigationReady }) =>
        useNativeInspectorBridge(tabId, true, navigationReady),
      { initialProps: { navigationReady: true } }
    );
    await waitFor(() => expect(result.current.canToggle).toBe(true));

    rerender({ navigationReady: false });
    expect(result.current.canToggle).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.isActive).toBe(false);
    expect(setInspectorMock).not.toHaveBeenCalled();

    act(() => listener?.({ tabId, type: 'INSPECT_READY' }));
    expect(setInspectorMock).not.toHaveBeenCalled();
    expect(result.current.canToggle).toBe(false);

    rerender({ navigationReady: true });
    await waitFor(() => expect(result.current.canToggle).toBe(true));
    act(() => result.current.toggle());
    expect(result.current.isActive).toBe(true);
    await waitFor(() =>
      expect(setInspectorMock).toHaveBeenCalledWith(tabId, true)
    );
  });

  it('导航期间保留已激活的拾取意图，并在新文档 READY 后恢复探针', async () => {
    const { result, rerender } = renderHook(
      ({ navigationReady }) =>
        useNativeInspectorBridge(tabId, true, navigationReady),
      { initialProps: { navigationReady: true } }
    );
    await waitFor(() => expect(result.current.canToggle).toBe(true));
    act(() => result.current.toggle());
    await waitFor(() => expect(setInspectorMock).toHaveBeenCalledTimes(1));

    rerender({ navigationReady: false });
    expect(result.current.canToggle).toBe(false);
    expect(result.current.isActive).toBe(true);
    expect(setInspectorMock).toHaveBeenCalledTimes(1);

    act(() => listener?.({ tabId, type: 'INSPECT_READY' }));
    await waitFor(() => expect(setInspectorMock).toHaveBeenCalledTimes(2));
    expect(setInspectorMock).toHaveBeenLastCalledWith(tabId, true);
    expect(result.current.isActive).toBe(true);
    expect(result.current.canToggle).toBe(false);

    rerender({ navigationReady: true });
    await waitFor(() => expect(result.current.canToggle).toBe(true));
    expect(result.current.isActive).toBe(true);
  });

  it('新文档 READY 会清除旧页面的选中元素', async () => {
    const { result } = renderHook(() => useNativeInspectorBridge(tabId));
    await waitFor(() => expect(result.current.canToggle).toBe(true));
    act(() => result.current.toggle());
    await waitFor(() => expect(setInspectorMock).toHaveBeenCalledTimes(1));

    act(() =>
      listener?.({
        tabId,
        type: 'INSPECT_SELECT',
        payload: {
          tagName: 'button',
          id: 'old-page',
          classes: [],
          attributes: {},
          bestSelector: '#old-page',
          xpath: '/html/body/button[1]',
          rect: { x: 0, y: 0, width: 1, height: 1 },
          computedStyles: {
            display: 'block',
            position: 'static',
            color: '',
            backgroundColor: '',
            fontSize: '',
            margin: '',
            padding: '',
          },
          outerHtmlSnippet: '<button />',
          textContent: 'old',
        },
      })
    );
    expect(result.current.selectedElement?.id).toBe('old-page');

    act(() => listener?.({ tabId, type: 'INSPECT_READY' }));
    expect(result.current.selectedElement).toBeNull();
    await waitFor(() => expect(setInspectorMock).toHaveBeenCalledTimes(2));
    expect(setInspectorMock).toHaveBeenLastCalledWith(tabId, true);
  });

  it('事件订阅尚未 ready 时禁止启用，订阅失败后禁用并提示原因', async () => {
    let subscriptionError!: (error: Error) => void;
    subscribeMock.mockImplementation((_callback, observer) => {
      subscriptionError = observer.onError;
      return unsubscribe;
    });
    const { result } = renderHook(() => useNativeInspectorBridge(tabId));

    expect(result.current.canToggle).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.isActive).toBe(false);
    expect(setInspectorMock).not.toHaveBeenCalled();

    act(() => subscriptionError(new Error('listen denied')));
    expect(result.current.canToggle).toBe(false);
    expect(result.current.isActive).toBe(false);
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining('listen denied')
    );
  });

  it('过滤其他 tab 事件并响应客户端 Esc toggle:false', async () => {
    const { result } = renderHook(() => useNativeInspectorBridge(tabId));
    await waitFor(() => expect(result.current.canToggle).toBe(true));
    act(() => result.current.toggle());
    await waitFor(() => expect(setInspectorMock).toHaveBeenCalledTimes(1));

    act(() => {
      listener?.({
        tabId: 'browser-other-leaf',
        type: 'INSPECT_SELECT',
        payload: {
          tagName: 'button',
          id: 'wrong-tab',
          classes: [],
          attributes: {},
          bestSelector: 'button',
          xpath: '/html/body/button',
          rect: { x: 0, y: 0, width: 1, height: 1 },
          computedStyles: {
            display: 'block',
            position: 'static',
            color: '',
            backgroundColor: '',
            fontSize: '',
            margin: '',
            padding: '',
          },
          outerHtmlSnippet: '<button />',
          textContent: '',
        },
      });
    });
    expect(result.current.selectedElement).toBeNull();

    act(() =>
      listener?.({ tabId, type: 'INSPECT_TOGGLE', payload: { enabled: false } })
    );
    expect(result.current.isActive).toBe(false);
    expect(setInspectorMock).toHaveBeenCalledTimes(1);

    act(() =>
      listener?.({
        tabId,
        type: 'INSPECT_HOVER',
        payload: {
          tagName: 'button',
          selector: 'button.late',
          rect: { x: 0, y: 0, width: 1, height: 1 },
        },
      })
    );
    expect(result.current.hoverElement).toBeNull();
  });

  it('卸载时发送停用命令并取消事件订阅', async () => {
    const { result, unmount } = renderHook(() =>
      useNativeInspectorBridge(tabId)
    );
    await waitFor(() => expect(result.current.canToggle).toBe(true));
    act(() => result.current.toggle());

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(setInspectorMock).toHaveBeenLastCalledWith(tabId, false)
    );
  });
});
