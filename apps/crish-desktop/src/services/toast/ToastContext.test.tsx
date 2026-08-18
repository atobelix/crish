// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';
import { ToastProvider, useToast, toast } from './ToastContext';

function TestConsumer() {
  const { showToast, dismissToast, toasts } = useToast();
  return (
    <div>
      <span data-testid="toast-count">{toasts.length}</span>
      <button
        type="button"
        onClick={() => showToast('测试错误通知')}
        data-testid="show-btn"
      >
        触发
      </button>
      <button
        type="button"
        onClick={() => toasts[0] && dismissToast(toasts[0].id)}
        data-testid="dismiss-btn"
      >
        关闭
      </button>
    </div>
  );
}

describe('ToastContext & useToast 单例基础设施', () => {
  beforeEach(() => {
    const root = document.createElement('div');
    root.id = 'toast-root';
    document.body.appendChild(root);
  });

  afterEach(() => {
    const root = document.getElementById('toast-root');
    if (root) document.body.removeChild(root);
  });

  it('ToastProvider 渲染并提供 useToast 上下文', () => {
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>
    );

    expect(screen.getByTestId('toast-count').textContent).toBe('0');
  });

  it('调用 showToast 能够更新 toasts 列表并在 Portal 容器内渲染', () => {
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>
    );

    act(() => {
      screen.getByTestId('show-btn').click();
    });

    expect(screen.getByTestId('toast-count').textContent).toBe('1');
    const portalRoot = document.getElementById('toast-root');
    expect(portalRoot?.textContent).toContain('测试错误通知');
  });

  it('调用 dismissToast 能够移除指定通知', () => {
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>
    );

    act(() => {
      screen.getByTestId('show-btn').click();
    });
    expect(screen.getByTestId('toast-count').textContent).toBe('1');

    act(() => {
      screen.getByTestId('dismiss-btn').click();
    });
    expect(screen.getByTestId('toast-count').textContent).toBe('0');
  });

  it('命令式 toast.show / toast.error 在 Provider 挂载后生效', () => {
    render(
      <ToastProvider>
        <div data-testid="child">App</div>
      </ToastProvider>
    );

    act(() => {
      toast.show('全局错误信息');
    });

    const portalRoot = document.getElementById('toast-root');
    expect(portalRoot?.textContent).toContain('全局错误信息');
  });

  it('useToast 在无 Provider 时平滑降级为全局 fallback 单例而不抛出异常崩溃', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { getByTestId } = render(<TestConsumer />);
    expect(getByTestId('toast-count').textContent).toBe('0');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[useToast] useToast called outside ToastProvider')
    );
    warnSpy.mockRestore();
  });
});
