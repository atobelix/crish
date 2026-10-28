// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  act,
  renderHook,
} from '@testing-library/react';
import { SmartPanel, useSmartPanel, type MenuItem } from '../index';
import { usePanelPosition } from '../hooks/usePanelPosition';

describe('SmartPanel Component Suite', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('does not render portal content when closed', () => {
    render(
      <SmartPanel
        open={false}
        items={[{ id: '1', label: 'Item 1' }]}
        trigger={<button>Trigger</button>}
      />
    );
    expect(screen.getByText('Trigger')).toBeInTheDocument();
    expect(screen.queryByText('Item 1')).not.toBeInTheDocument();
  });

  it('renders items, sublabels, shortcuts, badges, and icons when open', () => {
    const items: MenuItem[] = [
      {
        id: 'item-1',
        label: '新建会话',
        sublabel: '创建独立上下文',
        shortcut: 'Ctrl+N',
        badge: 'New',
        icon: <span data-testid="test-icon">icon</span>,
      },
    ];

    render(<SmartPanel open={true} items={items} />);
    expect(screen.getByText('新建会话')).toBeInTheDocument();
    expect(screen.getByText('创建独立上下文')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+N')).toBeInTheDocument();
    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.getByTestId('test-icon')).toBeInTheDocument();
  });

  it('handles item selection and onClose callback', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const itemOnSelect = vi.fn();

    const items: MenuItem[] = [
      { id: 'item-1', label: '重命名', onSelect: itemOnSelect },
    ];

    render(
      <SmartPanel
        open={true}
        items={items}
        onSelect={onSelect}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByText('重命名'));
    expect(itemOnSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not trigger onSelect for disabled items', () => {
    const onSelect = vi.fn();
    const items: MenuItem[] = [
      { id: 'disabled-item', label: '禁用操作', disabled: true },
    ];

    render(<SmartPanel open={true} items={items} onSelect={onSelect} />);
    const btn = screen.getByRole('menuitem', { name: '禁用操作' });
    fireEvent.click(btn);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('renders danger items with danger styling', () => {
    const items: MenuItem[] = [
      { id: 'delete-item', label: '删除会话', danger: true },
    ];

    render(<SmartPanel open={true} items={items} />);
    const btn = screen.getByRole('menuitem', { name: '删除会话' });
    expect(btn.className).toContain('danger');
  });

  it('renders selectable items with checkmark when selected', () => {
    const items: MenuItem[] = [
      { id: 'opt-1', type: 'selectable', label: '选项 A', selected: true },
      { id: 'opt-2', type: 'selectable', label: '选项 B', selected: false },
    ];

    render(<SmartPanel open={true} items={items} />);
    const optA = screen.getByRole('menuitemcheckbox', { name: '选项 A' });
    expect(optA).toHaveAttribute('aria-selected', 'true');
  });

  it('filters items when typing in embedded search bar', () => {
    const items: MenuItem[] = [
      { id: 'item-1', label: '导出为 Markdown' },
      { id: 'item-2', label: '复制 ID' },
      { id: 'item-3', label: '重命名' },
    ];

    render(<SmartPanel open={true} items={items} enableSearch={true} />);
    const searchInput = screen.getByRole('searchbox');
    expect(screen.getByText('导出为 Markdown')).toBeInTheDocument();
    expect(screen.getByText('复制 ID')).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: '导出' } });
    expect(screen.getByText('导出为 Markdown')).toBeInTheDocument();
    expect(screen.queryByText('复制 ID')).not.toBeInTheDocument();
    expect(screen.queryByText('重命名')).not.toBeInTheDocument();
  });

  it('supports searchRightActions slot', () => {
    const onActionClick = vi.fn();
    render(
      <SmartPanel
        open={true}
        items={[{ id: '1', label: 'Item 1' }]}
        enableSearch={true}
        searchRightActions={
          <button data-testid="custom-action-btn" onClick={onActionClick}>
            Action
          </button>
        }
      />
    );

    const actionBtn = screen.getByTestId('custom-action-btn');
    expect(actionBtn).toBeInTheDocument();
    fireEvent.click(actionBtn);
    expect(onActionClick).toHaveBeenCalledTimes(1);
  });

  it('supports collapsible accordion sections', () => {
    const items: MenuItem[] = [
      {
        id: 'adv',
        type: 'collapsible',
        label: '高级选项',
        children: [
          { id: 'sub-1', label: '导出配置' },
          { id: 'sub-2', label: '导入配置' },
        ],
      },
    ];

    render(<SmartPanel open={true} items={items} />);
    const headerBtn = screen.getByText('高级选项');
    expect(headerBtn).toBeInTheDocument();
    expect(screen.getByText('导出配置')).toBeInTheDocument();

    fireEvent.click(headerBtn);
  });

  it('supports cascading submenu rendering', () => {
    const items: MenuItem[] = [
      {
        id: 'tools',
        type: 'submenu',
        label: '工具箱',
        children: [
          { id: 'tool-1', label: '格式化' },
          { id: 'tool-2', label: '代码检查' },
        ],
      },
    ];

    render(<SmartPanel open={true} items={items} />);
    const toolBtn = screen.getByText('工具箱');
    expect(toolBtn).toBeInTheDocument();

    fireEvent.mouseEnter(toolBtn);
    expect(screen.getByText('格式化')).toBeInTheDocument();
  });

  it('supports keyboard navigation (ArrowDown, ArrowUp, Enter, Escape)', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const items: MenuItem[] = [
      { id: 'item-1', label: '第一项' },
      { id: 'item-2', label: '第二项' },
    ];

    render(
      <SmartPanel
        open={true}
        items={items}
        onSelect={onSelect}
        onClose={onClose}
      />
    );

    const container = screen.getByRole('menu');
    // Initially focused on item-1 (index 0). ArrowDown moves to item-2 (index 1).
    fireEvent.keyDown(container, { key: 'ArrowDown' });
    fireEvent.keyDown(container, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(items[1], expect.anything());

    fireEvent.keyDown(container, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('useSmartPanel hook manages state correctly', () => {
    let hookResult!: ReturnType<typeof useSmartPanel>;

    const TestComponent = () => {
      hookResult = useSmartPanel(false);
      return (
        <div>
          <button onClick={hookResult.open}>Open</button>
          <button onClick={hookResult.close}>Close</button>
          <button onClick={hookResult.toggle}>Toggle</button>
        </div>
      );
    };

    render(<TestComponent />);
    expect(hookResult.isOpen).toBe(false);

    act(() => {
      hookResult.open();
    });
    expect(hookResult.isOpen).toBe(true);

    act(() => {
      hookResult.close();
    });
    expect(hookResult.isOpen).toBe(false);

    act(() => {
      hookResult.openAtPoint({ x: 100, y: 200 });
    });
    expect(hookResult.isOpen).toBe(true);
    expect(hookResult.point).toEqual({ x: 100, y: 200 });
  });

  describe('usePanelPosition 视口底部翻折与几何对齐测试', () => {
    it('同时存在 triggerRef 与 point 时优先使用 DOM 锚点，侧栏更多按钮向上翻折底边紧贴按钮底边 (0 gap)', () => {
      // 保证视口高度足够 (1000px)，bounds.bottom = 988px
      window.innerHeight = 1000;

      const button = document.createElement('button');
      button.dataset.testid = 'session-more-button';
      document.body.appendChild(button);
      // 模拟按钮在视口底部: top: 900, bottom: 928, height: 28, left: 100, right: 128
      button.getBoundingClientRect = () =>
        ({
          left: 100,
          top: 900,
          right: 128,
          bottom: 928,
          width: 28,
          height: 28,
        }) as DOMRect;

      const panel = document.createElement('div');
      document.body.appendChild(panel);
      Object.defineProperty(panel, 'offsetWidth', {
        value: 200,
        configurable: true,
      });
      Object.defineProperty(panel, 'offsetHeight', {
        value: 240,
        configurable: true,
      });

      const { result } = renderHook(() =>
        usePanelPosition({
          isOpen: true,
          triggerRef: { current: button },
          point: { x: 134, y: 900 }, // 传入 point，绝不忽略 triggerRef
          panelRef: { current: panel },
          options: { side: 'right', align: 'start', sideOffset: 6 },
        })
      );

      // 向上翻折
      expect(result.current.directionY).toBe('up');
      // 水平放置于按钮右侧 + sideOffset
      expect(result.current.x).toBe(128 + 6); // 134
      // 关键几何定理：向上翻折时 targetY = triggerRect.bottom - actualPanelHeight
      expect(result.current.y).toBe(928 - 240); // 688
      // 面板底边 688 + 240 = 928，与按钮底边 928 紧贴，垂直间隙精确为 0！
      expect(result.current.y + 240).toBe(928);

      document.body.removeChild(button);
      document.body.removeChild(panel);
    });

    it('常规主轴垂直弹出 (side: bottom) 靠近视口底部向上翻折：面板底边距离按钮顶边精确为 sideOffset', () => {
      window.innerHeight = 1000;

      const button = document.createElement('button');
      document.body.appendChild(button);
      button.getBoundingClientRect = () =>
        ({
          left: 200,
          top: 880,
          right: 300,
          bottom: 912,
          width: 100,
          height: 32,
        }) as DOMRect;

      const panel = document.createElement('div');
      document.body.appendChild(panel);
      Object.defineProperty(panel, 'offsetWidth', {
        value: 200,
        configurable: true,
      });
      Object.defineProperty(panel, 'offsetHeight', {
        value: 200,
        configurable: true,
      });

      const { result } = renderHook(() =>
        usePanelPosition({
          isOpen: true,
          triggerRef: { current: button },
          panelRef: { current: panel },
          options: { side: 'bottom', align: 'start', sideOffset: 8 },
        })
      );

      expect(result.current.directionY).toBe('up');
      // 向上翻折时 targetY = triggerRect.top - sideOffset - actualPanelHeight
      expect(result.current.y).toBe(880 - 8 - 200); // 672
      // 面板底边距离按钮顶边精确为 8px (sideOffset)
      expect(880 - (result.current.y + 200)).toBe(8);

      document.body.removeChild(button);
      document.body.removeChild(panel);
    });

    it('仅传入 point 向上翻折时基于 actualPanelHeight 解算，绝不产生虚高虚空推离', () => {
      window.innerHeight = 1000;

      const panel = document.createElement('div');
      document.body.appendChild(panel);
      Object.defineProperty(panel, 'offsetWidth', {
        value: 200,
        configurable: true,
      });
      Object.defineProperty(panel, 'offsetHeight', {
        value: 210,
        configurable: true,
      });

      const { result } = renderHook(() =>
        usePanelPosition({
          isOpen: true,
          point: { x: 300, y: 950 }, // 靠近底部
          panelRef: { current: panel },
        })
      );

      expect(result.current.directionY).toBe('up');
      // targetY = point.y - actualPanelHeight = 950 - 210 = 740
      expect(result.current.y).toBe(950 - 210); // 740
      // 面板底边紧贴 point.y，绝无 30px~60px 虚空断层
      expect(result.current.y + 210).toBe(950);

      document.body.removeChild(panel);
    });
  });
});
