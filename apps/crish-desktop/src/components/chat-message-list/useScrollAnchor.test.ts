// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderHook, act } from '@testing-library/react';
import {
  pinSnippet,
  scrollToMessage,
  useScrollAnchor,
} from './useScrollAnchor';
import type { SessionMessage } from '../../store/types';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

describe('useScrollAnchor & 单一滚动宿主契约 (DIM-02 §1.1)', () => {
  let scroller: HTMLDivElement;
  let targetRow: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    scroller = document.createElement('div');
    scroller.setAttribute('data-chat-scroll-container', '');
    scroller.style.overflowY = 'auto';
    scroller.scrollTop = 100;

    targetRow = document.createElement('div');
    targetRow.setAttribute('data-msg-id', 'msg-123');
    scroller.appendChild(targetRow);
    document.body.appendChild(scroller);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('pinSnippet 文本裁剪契约', () => {
    expect(pinSnippet('')).toBe('（无文本）');
    expect(pinSnippet('   ')).toBe('（无文本）');
    expect(pinSnippet('hello world', 5)).toBe('hello…');
    expect(pinSnippet('hello world', 20)).toBe('hello world');
  });

  it('scrollToMessage 当消息不存在时返回 false', () => {
    expect(scrollToMessage('non-existent')).toBe(false);
  });

  it('scrollToMessage 不调用原生 scrollIntoView，直接向滚动容器的 scrollTop 写入目标值', () => {
    const scrollIntoViewSpy = vi.fn();
    targetRow.scrollIntoView = scrollIntoViewSpy;

    // 模拟几何坐标
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({
      top: 50,
      bottom: 650,
      height: 600,
      left: 0,
      right: 800,
      width: 800,
      x: 0,
      y: 50,
      toJSON: () => {},
    });
    vi.spyOn(targetRow, 'getBoundingClientRect').mockReturnValue({
      top: 250,
      bottom: 330,
      height: 80,
      left: 0,
      right: 800,
      width: 800,
      x: 0,
      y: 250,
      toJSON: () => {},
    });
    Object.defineProperty(scroller, 'clientHeight', { value: 600, configurable: true });
    Object.defineProperty(targetRow, 'clientHeight', { value: 80, configurable: true });

    const ok = scrollToMessage('msg-123');
    expect(ok).toBe(true);

    // 严格断言：禁止调用原生 scrollIntoView
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();

    // 计算逻辑：
    // diff = targetRow.top - scroller.top = 250 - 50 = 200
    // relativeOffsetTop = diff + scroller.scrollTop (100) = 300
    // viewportHeight = 600, targetHeight = 80
    // centerOffset = (600 - 80) / 2 = 260
    // targetScrollTop = Math.max(0, 300 - 260) = 40
    expect(scroller.scrollTop).toBe(40);
  });

  it('scrollToMessage 支持 data-vindex 与 data-chat-node-key 寻址', () => {
    const virtualRow = document.createElement('div');
    virtualRow.setAttribute('data-vindex', 'msg-virtual');
    scroller.appendChild(virtualRow);

    const ok = scrollToMessage('msg-virtual');
    expect(ok).toBe(true);
  });

  it('jumpToPinned 消息跳转逻辑能触发现场滚动', () => {
    const mockMessages: SessionMessage[] = [
      { id: 'msg-123', sender: 'user', text: 'hello' } as SessionMessage,
    ];

    const { result } = renderHook(() =>
      useScrollAnchor({
        messages: mockMessages,
        sessionAllMessages: mockMessages,
        showAllMessages: true,
      })
    );

    act(() => {
      result.current.jumpToPinned('msg-123');
    });

    expect(targetRow.className).toContain('rowPinFlash');
  });

  it('ChatMessageList.module.css 样式断言：确立 [data-chat-scroll-container] 为唯一滚动容器，子列表 visible', () => {
    const css = readFileSync(join(DIR, 'ChatMessageList.module.css'), 'utf8');

    // 宿主包含块与滚动容器
    expect(css).toMatch(/\[data-chat-scroll-container\]/);
    expect(css).toMatch(/overflow-y:\s*auto/);

    // 子层级 pinnedList 严格设为 overflow-y: visible，杜绝局部滚动条
    expect(css).toMatch(/\.pinnedList\s*\{[\s\S]*?overflow-y:\s*visible/);
    expect(css).not.toMatch(/\.pinnedList\s*\{[\s\S]*?overflow-y:\s*auto/);
    expect(css).not.toMatch(/\.pinnedList\s*\{[\s\S]*?overflow-y:\s*scroll/);
  });
});
