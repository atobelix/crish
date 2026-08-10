// @vitest-environment jsdom
/**
 * StreamingTextBlock 语义测试（08-detail T1.6 / 2.4 + R2-4 N1 seq 修复）。
 *
 * 契约红线（任何路径不得向本组件传 children/text prop）：
 * - delta-only props + seq 帧序号，children 恒为空 → React 从不协调文本子节点，
 *   DOM 文本由 useLayoutEffect 在提交后直写（O(增量) appendChild）；
 * - append 累积 = 各 delta 拼接（严格单调，调用方 stripper 保证）；
 * - seq 单调递增 → 同值新帧（delta 相同 seq+1）照常 append（N1 修复）；
 * - 同 seq（StrictMode effect 双执行）→ 不重复 append（seq 守卫）；
 * - 重挂载（key=msg.id 变更）→ 新节点天然空、从零累积。
 */
import React from 'react';
import { render, act } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { StreamingTextBlock } from './StreamingTextBlock';

let origError: typeof console.error;
afterEach(() => {
  if (origError) console.error = origError;
});

function suppressActWarnings() {
  origError = console.error;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('not wrapped in act')) return;
    origError.call(console, ...args);
  };
}

describe('StreamingTextBlock（T1.6）', () => {
  suppressActWarnings();

  it('append 累积：节点文本 = 各 delta 拼接（seq 递增）', () => {
    const { container, rerender } = render(<StreamingTextBlock delta={'第一段\n'} seq={1} />);
    expect(container.textContent).toBe('第一段\n');
    rerender(<StreamingTextBlock delta={'第二段'} seq={2} />);
    expect(container.textContent).toBe('第一段\n第二段');
    rerender(<StreamingTextBlock delta={''} seq={3} />);
    expect(container.textContent).toBe('第一段\n第二段');
    rerender(<StreamingTextBlock delta={'第三段\n'} seq={4} />);
    expect(container.textContent).toBe('第一段\n第二段第三段\n');
  });

  it('同值新帧（delta 相同 seq+1）照常 append（N1 修复：同值帧不再丢字）', () => {
    const { container, rerender } = render(<StreamingTextBlock delta={'x'} seq={1} />);
    expect(container.textContent).toBe('x');
    rerender(<StreamingTextBlock delta={'x'} seq={2} />);
    expect(container.textContent).toBe('xx');
    rerender(<StreamingTextBlock delta={'x'} seq={3} />);
    expect(container.textContent).toBe('xxx');
  });

  it('StrictMode effect 双执行守卫（同 seq）：节点文本 = delta 而非 delta+delta', () => {
    const { container } = render(
      <React.StrictMode>
        <StreamingTextBlock delta={'strict-1'} seq={1} />
      </React.StrictMode>
    );
    expect(container.textContent).toBe('strict-1');
  });

  it('StrictMode 下连续帧仍单调累积（seq 递增，双执行守卫不吞增量）', () => {
    const { container, rerender } = render(
      <React.StrictMode>
        <StreamingTextBlock delta={'a'} seq={1} />
      </React.StrictMode>
    );
    expect(container.textContent).toBe('a');
    rerender(
      <React.StrictMode>
        <StreamingTextBlock delta={'b'} seq={2} />
      </React.StrictMode>
    );
    expect(container.textContent).toBe('ab');
  });

  it('重挂载（key 变更）→ 节点文本归零后重新累积', () => {
    const { container, rerender } = render(
      <StreamingTextBlock key="msg-a" delta={'旧消息'} seq={1} />
    );
    expect(container.textContent).toBe('旧消息');
    act(() => {
      rerender(<StreamingTextBlock key="msg-b" delta={'新消息'} seq={1} />);
    });
    // 新 key → React 卸载旧节点挂载新节点（container 内只有一个文本节点）
    expect(container.textContent).toBe('新消息');
  });

  it('空壳 div：data-streaming 标记与样式类存在，无 children 文本节点残留', () => {
    const { container } = render(<StreamingTextBlock delta={'内容'} seq={1} />);
    const div = container.querySelector('div[data-streaming="true"]');
    expect(div).not.toBeNull();
    // children 只有 ref div；div 内部仅文本节点（无 React children 结构）
    expect(container.querySelectorAll('div').length).toBe(1);
  });

  it('delta 为空串时不产生空文本节点', () => {
    const { container } = render(<StreamingTextBlock delta={''} seq={1} />);
    expect(container.querySelectorAll('div').length).toBe(1);
    expect(container.textContent).toBe('');
  });

  it('vi 探针：append 写入量 = delta 长度（O(增量) 断言口径）', () => {
    const appendChildSpy = vi.spyOn(Node.prototype, 'appendChild');
    const { rerender } = render(<StreamingTextBlock delta={'短'} seq={1} />);
    rerender(<StreamingTextBlock delta={'更长的增量内容'} seq={2} />);
    // 每次 append 恰好一个 Text 节点；节点内容 = 该帧 delta
    const textNodes = appendChildSpy.mock.calls
      .map((c) => c[0])
      .filter((n): n is Text => n instanceof Text);
    expect(textNodes.map((n) => n.textContent).join('')).toBe('短更长的增量内容');
    appendChildSpy.mockRestore();
  });
});
