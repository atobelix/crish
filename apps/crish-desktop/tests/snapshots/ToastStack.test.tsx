// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ToastStack } from '../../src/components/overlay/ToastStack';
import type { AppToast } from '../../src/hooks/useToastQueue';

const baseToast: AppToast = {
  id: 'toast_1',
  type: 'info',
  message: '操作成功',
  duration: 3000,
  ariaLive: 'polite',
  timestamp: Date.now(),
};

describe('ToastStack snapshots', () => {
  it('renders single toast', () => {
    const { container } = render(
      <ToastStack toasts={[baseToast]} onDismiss={vi.fn()} />
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it('renders multiple toasts', () => {
    const toasts: AppToast[] = [
      { ...baseToast, id: 'toast_1', message: '第一条通知' },
      { ...baseToast, id: 'toast_2', message: '第二条通知', type: 'success' },
      { ...baseToast, id: 'toast_3', message: '警告信息', type: 'warning' },
    ];
    const { container } = render(
      <ToastStack toasts={toasts} onDismiss={vi.fn()} />
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it('renders toast with undo', () => {
    const toast: AppToast = {
      ...baseToast,
      message: '文件已删除',
      type: 'error',
      ariaLive: 'assertive',
      onUndo: vi.fn(),
    };
    const { container } = render(
      <ToastStack toasts={[toast]} onDismiss={vi.fn()} />
    );
    expect(container.firstChild).toMatchSnapshot();
  });
});
