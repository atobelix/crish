// @vitest-environment jsdom
/**
 * hooks/useChatAutoScroll 增量滚动收缩补偿测试（审计 F7-F17）
 *
 * 缺陷：增量滚动以 `el.scrollTop += dh`（scrollHeight 增量）为基准；
 * 当新行实际高度 < 估算高度时 scrollHeight 缩小（dh ≤ 0），不执行滚动，
 * 长代码块消息渲染后底部残留空白。
 *
 * 修复契约：内容收缩（dh < 0）且当前贴底时重新吸附到真实底部。
 *
 * 注：rerender 与 rAF 等待必须分属独立 act 作用域（同一 act 内的
 * 内联等待不释放 jsdom rAF 定时器）。
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { useChatAutoScroll } from './useChatAutoScroll';

function Harness({ messages, processing }: { messages: unknown[]; processing?: boolean }) {
  const { chatFlowRef } = useChatAutoScroll(messages, processing);
  return (
    <div ref={chatFlowRef}>
      <div data-virtual-scroll="true" />
    </div>
  );
}

async function rerenderAndFlush(rerender: (el: React.ReactElement) => void, el: React.ReactElement) {
  await act(async () => {
    rerender(el);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
}

async function flushRaf() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
}

describe('hooks/useChatAutoScroll（F7-F17）', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function setup() {
    const utils = render(<Harness messages={['m1']} processing />);
    const el = utils.container.querySelector(
      '[data-virtual-scroll="true"]'
    ) as HTMLElement;
    Object.defineProperty(el, 'scrollHeight', { value: 500, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 300, configurable: true });
    el.scrollTop = 0;
    return { el, rerender: utils.rerender };
  }

  it('内容增长：增量滚动跟随（基线契约）', async () => {
    const { el, rerender } = setup();
    await flushRaf();
    expect(el.scrollTop).toBe(500);
    Object.defineProperty(el, 'scrollHeight', { value: 800, configurable: true });
    await rerenderAndFlush(rerender, <Harness messages={['m1', 'm2']} processing />);
    expect(el.scrollTop).toBe(800);
  });

  it('内容收缩（dh<0）：贴底时重新吸附，不残留底部空白（F7-F17）', async () => {
    const { el, rerender } = setup();
    await flushRaf();
    // 增长后（scrollTop 跟随到 800）
    Object.defineProperty(el, 'scrollHeight', { value: 800, configurable: true });
    await rerenderAndFlush(rerender, <Harness messages={['m1', 'm2']} processing />);
    expect(el.scrollTop).toBe(800);
    // 新行实际高度 < 估算 → scrollHeight 收缩回 600（dh = -200）
    Object.defineProperty(el, 'scrollHeight', { value: 600, configurable: true });
    await rerenderAndFlush(rerender, <Harness messages={['m1', 'm2-收缩']} processing />);
    // 贴底时应重新吸附：scrollTop = scrollHeight - clientHeight = 300
    expect(el.scrollTop).toBe(300);
  });

  it('内容收缩但用户已上翻时不强行吸附（不打扰阅读）', async () => {
    const { el, rerender } = setup();
    await flushRaf();
    Object.defineProperty(el, 'scrollHeight', { value: 800, configurable: true });
    await rerenderAndFlush(rerender, <Harness messages={['m1', 'm2']} processing />);
    // 用户上翻到中部
    el.scrollTop = 200;
    Object.defineProperty(el, 'scrollHeight', { value: 600, configurable: true });
    await rerenderAndFlush(rerender, <Harness messages={['m1', 'm2-收缩']} processing />);
    expect(el.scrollTop).toBe(200);
  });
});
