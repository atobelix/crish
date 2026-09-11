// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import {
  SmartPanel,
  useSmartPanel,
  type MenuItem,
} from '../index';

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
});
