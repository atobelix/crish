// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useThoughtInspectorStore } from '../../store/thoughtInspectorStore';
import { THINKING_PREVIEW_CHARS } from './narrativeModel';
import { ThinkingBlock } from './ThinkingBlock';

describe('ThinkingBlock', () => {
  afterEach(() => {
    cleanup();
    useThoughtInspectorStore.getState().closeThoughtInspector();
  });

  const long = '思'.repeat(80);

  it('默认只有预览、无全文节点', () => {
    const { container } = render(<ThinkingBlock content={long} />);
    expect(container.querySelector('[data-flow-thinking-full]')).toBeNull();
    expect(container.querySelector('[data-flow-thinking-preview]')).not.toBeNull();
    expect(container.textContent ?? '').not.toContain(long);
    const preview = container.querySelector('[data-flow-thinking-preview]');
    expect((preview?.textContent ?? '').length).toBeLessThanOrEqual(
      THINKING_PREVIEW_CHARS + 8
    );
  });

  it('展开才挂全文', () => {
    const { container } = render(<ThinkingBlock content={long} />);
    fireEvent.click(screen.getByRole('button', { name: /思考过程/ }));
    const full = container.querySelector('[data-flow-thinking-full]');
    expect(full).not.toBeNull();
    expect(full?.textContent).toBe(long);
    expect(container.querySelector('[data-flow-thinking-preview]')).toBeNull();
  });

  it('live 计时 1Hz，卸载 clearInterval', () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(window, 'setInterval');
    const clearSpy = vi.spyOn(window, 'clearInterval');
    const { container, unmount } = render(
      <ThinkingBlock content="正在想" isLive />
    );
    expect(setSpy.mock.calls.some((c) => c[1] === 1000)).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.textContent).toMatch(/1s/);
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    setSpy.mockRestore();
    clearSpy.mockRestore();
    vi.useRealTimers();
  });

  it('查阅器入口打开 thoughtInspector，无原生 title', () => {
    const { container } = render(
      <ThinkingBlock content={long} messageId="m1" />
    );
    expect(container.querySelector('[title]')).toBeNull();
    fireEvent.click(screen.getByLabelText('查看完整思考链'));
    expect(useThoughtInspectorStore.getState().isOpen).toBe(true);
    expect(useThoughtInspectorStore.getState().content).toBe(long);
    expect(useThoughtInspectorStore.getState().activeMessageId).toBe('m1');
  });
});
