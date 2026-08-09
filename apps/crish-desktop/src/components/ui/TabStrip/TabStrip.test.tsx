// @vitest-environment jsdom
/**
 * ui/TabStrip 测试（T-C 批次 5.2 · T12）
 * 移植自 UnitSessionTabStrip S4.5 a11y 专项：roving tabindex / 键盘漫游 /
 * 关闭键 / 溢出 helper；附加受控协议与插槽断言。
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { TabStrip, readStripOverflow, type TabStripItem } from './TabStrip';

const TABS: TabStripItem[] = [
  { id: 'a', label: '标签 A' },
  { id: 'b', label: '标签 B', closable: true },
];

function Tabs(props: Partial<React.ComponentProps<typeof TabStrip>>) {
  return (
    <TabStrip
      tabs={TABS}
      activeId="a"
      onActiveChange={() => undefined}
      ariaLabel="测试标签"
      {...props}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ui/TabStrip', () => {
  it('tablist/tab 语义：role + aria-selected + aria-orientation', () => {
    const { container } = render(<Tabs />);
    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist).not.toBeNull();
    expect(tablist).toHaveAttribute('aria-label', '测试标签');
    expect(tablist).toHaveAttribute('aria-orientation', 'horizontal');
    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
  });

  it('roving tabindex：仅 roving 锚点 tab 为 0，其余 -1', () => {
    const { container } = render(<Tabs />);
    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs[0]!.getAttribute('tabindex')).toBe('0');
    expect(tabs[1]!.getAttribute('tabindex')).toBe('-1');
  });

  it('ArrowRight 移动 roving 焦点并激活下一 tab', () => {
    const onActiveChange = vi.fn();
    const { container } = render(<Tabs onActiveChange={onActiveChange} />);
    const tabs = () => container.querySelectorAll('[role="tab"]');
    tabs()[0]!.focus();
    fireEvent.keyDown(tabs()[0]!, { key: 'ArrowRight' });
    expect(tabs()[1]!.getAttribute('tabindex')).toBe('0');
    expect(tabs()[0]!.getAttribute('tabindex')).toBe('-1');
    expect(onActiveChange).toHaveBeenCalledWith('b');
  });

  it('ArrowLeft / Home / End 键盘漫游', () => {
    const onActiveChange = vi.fn();
    const { container } = render(<Tabs onActiveChange={onActiveChange} />);
    const tabs = () => container.querySelectorAll('[role="tab"]');
    fireEvent.keyDown(tabs()[1]!, { key: 'End' });
    fireEvent.keyDown(tabs()[1]!, { key: 'ArrowLeft' });
    expect(tabs()[0]!.getAttribute('tabindex')).toBe('0');
    expect(onActiveChange).toHaveBeenCalledWith('a');
    fireEvent.keyDown(tabs()[0]!, { key: 'End' });
    expect(onActiveChange).toHaveBeenCalledWith('b');
    fireEvent.keyDown(tabs()[1]!, { key: 'Home' });
    expect(onActiveChange).toHaveBeenCalledWith('a');
  });

  it('Enter / Space 激活当前聚焦 tab', () => {
    const onActiveChange = vi.fn();
    const { container } = render(<Tabs onActiveChange={onActiveChange} />);
    const tabs = () => container.querySelectorAll('[role="tab"]');
    fireEvent.keyDown(tabs()[1]!, { key: 'Enter' });
    expect(onActiveChange).toHaveBeenCalledWith('b');
    fireEvent.keyDown(tabs()[1]!, { key: ' ' });
    expect(onActiveChange).toHaveBeenCalledWith('b');
  });

  it('Delete/Backspace 关闭可关闭 tab（closable=false 不触发）', () => {
    const onClose = vi.fn();
    const { container } = render(<Tabs onClose={onClose} />);
    const tabs = () => container.querySelectorAll('[role="tab"]');
    fireEvent.keyDown(tabs()[1]!, { key: 'Delete' });
    expect(onClose).toHaveBeenCalledWith('b', expect.anything());
    fireEvent.keyDown(tabs()[1]!, { key: 'Backspace' });
    expect(onClose).toHaveBeenCalledTimes(2);
    const onCloseStrict = vi.fn();
    const { container: c2 } = render(
      <Tabs
        onClose={onCloseStrict}
        tabs={[{ id: 'a', label: '标签 A', closable: false }]}
      />
    );
    fireEvent.keyDown(c2.querySelector('[role="tab"]')!, { key: 'Delete' });
    expect(onCloseStrict).not.toHaveBeenCalled();
  });

  it('onClose 缺省时 Delete 不触发任何行为', () => {
    const onActiveChange = vi.fn();
    const { container } = render(<Tabs onActiveChange={onActiveChange} />);
    fireEvent.keyDown(container.querySelectorAll('[role="tab"]')[0]!, {
      key: 'Delete',
    });
    expect(onActiveChange).not.toHaveBeenCalled();
  });

  it('renderTab 插槽：渲染自定义内容且内部按钮 tabIndex=-1 不打断漫游', () => {
    const { container } = render(
      <Tabs
        renderTab={(tab) => (
          <>
            <button type="button" tabIndex={-1} onClick={() => undefined}>
              {tab.label}
            </button>
            <button
              type="button"
              tabIndex={-1}
              aria-label={`关闭 ${tab.label}`}
              onClick={() => undefined}
            >
              ×
            </button>
          </>
        )}
      />
    );
    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs[0]!.querySelector('button')!.textContent).toBe('标签 A');
    for (const tab of Array.from(tabs)) {
      for (const btn of tab.querySelectorAll('button')) {
        expect(btn.getAttribute('tabindex')).toBe('-1');
      }
    }
  });

  it('leading/trailing 插槽渲染于滚动容器内', () => {
    const { container } = render(
      <Tabs leading={<button type="button">前</button>} trailing={<button type="button">后</button>} />
    );
    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist!.textContent).toContain('前');
    expect(tablist!.textContent).toContain('后');
  });

  it('per-tab data 属性透传（业务埋点/测试定位）', () => {
    const { container } = render(
      <Tabs tabs={[{ id: 'a', label: 'A', data: { 'data-session-id': 'sess-1', 'data-tab-id': 'tab-a' } }]} />
    );
    const tab = container.querySelector('[role="tab"]')!;
    expect(tab.getAttribute('data-session-id')).toBe('sess-1');
    expect(tab.getAttribute('data-tab-id')).toBe('tab-a');
  });

  it('wrap 层 data 属性与 overflow 标记接线', () => {
    const { container } = render(
      <Tabs data={{ 'data-strip-kind': 'unit' }} className="wrap-cls" scrollClassName="scroll-cls" />
    );
    const wrap = container.firstElementChild!;
    expect(wrap).toHaveAttribute('data-strip-kind', 'unit');
    expect(wrap.className).toContain('wrap-cls');
    expect(wrap.querySelector('.scroll-cls')).not.toBeNull();
  });

  it('readStripOverflow：无溢出双 false；有滚动边正确', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollWidth', { value: 100, configurable: true });
    Object.defineProperty(el, 'clientWidth', { value: 100, configurable: true });
    Object.defineProperty(el, 'scrollLeft', {
      value: 0,
      writable: true,
      configurable: true,
    });
    expect(readStripOverflow(el)).toEqual({ start: false, end: false });
    Object.defineProperty(el, 'scrollWidth', { value: 300, configurable: true });
    el.scrollLeft = 0;
    expect(readStripOverflow(el)).toEqual({ start: false, end: true });
    el.scrollLeft = 200;
    expect(readStripOverflow(el)).toEqual({ start: true, end: false });
    el.scrollLeft = 80;
    expect(readStripOverflow(el)).toEqual({ start: true, end: true });
  });
});
