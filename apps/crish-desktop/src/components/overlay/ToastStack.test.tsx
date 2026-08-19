// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AppToast } from '../../hooks/useToastQueue';
import { ToastStack } from './ToastStack';

const DIR = dirname(fileURLToPath(import.meta.url));

const mk = (partial: Partial<AppToast> & Pick<AppToast, 'id' | 'message'>): AppToast => ({
  type: 'info',
  duration: 3000,
  ariaLive: 'polite',
  timestamp: Date.now(),
  ...partial,
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ToastStack I7 皮', () => {
  it('关闭钮不是 Button ghost sm，按 type 分皮', () => {
    render(
      <ToastStack
        toasts={[
          mk({ id: 'e', message: '保存失败', type: 'error', ariaLive: 'assertive' }),
          mk({ id: 's', message: '已保存', type: 'success' }),
        ]}
        onDismiss={vi.fn()}
      />,
    );

    const errorToast = screen.getByText('保存失败').closest('[role="status"]');
    const successToast = screen.getByText('已保存').closest('[role="status"]');
    expect(errorToast).toHaveAttribute('data-toast-type', 'error');
    expect(successToast).toHaveAttribute('data-toast-type', 'success');

    const closeBtns = screen.getAllByRole('button', { name: '关闭通知' });
    expect(closeBtns.length).toBe(2);
    for (const btn of closeBtns) {
      expect(btn.getAttribute('data-variant')).not.toBe('ghost');
      expect(btn.getAttribute('data-size')).not.toBe('sm');
      expect(btn.className).not.toMatch(/buttonGhost|buttonSm/);
    }
  });

  it('关闭后走退场再 onDismiss', async () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <ToastStack
        toasts={[mk({ id: 't1', message: '复制失败', type: 'error' })]}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '关闭通知' }));
    expect(onDismiss).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(onDismiss).toHaveBeenCalledWith('t1');
  });

  it('CSS 不以右侧过冲弹入，关闭无 tint-active 灰块', () => {
    const css = readFileSync(join(DIR, 'ToastStack.module.css'), 'utf8');
    expect(css).not.toMatch(/toast-slide-in/);
    expect(css).not.toMatch(/translateX\(120%\)/);
    expect(css).not.toMatch(/--transition-enter/);
    expect(css).not.toMatch(/--tint-active/);
    expect(css).toMatch(/data-toast-type='error'/);
    expect(css).toMatch(/data-toast-type='success'/);
  });
});
