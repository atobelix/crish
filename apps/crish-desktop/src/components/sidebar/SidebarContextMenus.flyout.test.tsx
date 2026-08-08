// @vitest-environment jsdom
/**
 * SidebarContextMenus flyout 子菜单关闭语义测试（审计 F7-F12）
 *
 * 缺陷：只实现 handleFlyEnter（80ms 延迟打开），无 mouseleave/
 * ArrowLeft/Esc 单独关闭逻辑；子菜单打开后鼠标移出菜单区域仍保持展开，
 * 键盘用户无法用方向键在 flyout 与父菜单间导航。
 *
 * 修复契约：
 * 1. 鼠标移出行/飞层后关闭（宽限期容错，移入飞层内不误关）；
 * 2. ArrowRight 打开并聚焦首项；ArrowLeft/Esc 关闭飞层且不关闭整个菜单。
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { SidebarContextMenus } from './SidebarContextMenus';

function renderSortMenu() {
  const props = {
    menuRef: React.createRef<HTMLDivElement>(),
    sortMenuRef: React.createRef<HTMLDivElement>(),
    contextMenu: null,
    onSessionAction: vi.fn(),
    sortDropdownOpen: true,
    sortDropdownCoords: { x: 100, y: 200 },
    sortType: 'active' as const,
    groupType: 'folder' as const,
    filterType: 'all' as const,
    onSetSortType: vi.fn(),
    onSetGroupType: vi.fn(),
    onSetFilterType: vi.fn(),
    onCloseSortDropdown: vi.fn(),
    onCloseContextMenu: vi.fn(),
  };
  const utils = render(<SidebarContextMenus {...props} />);
  return { utils, props };
}

function openFlyout(label: string) {
  const row = screen.getByText(label).closest('div');
  fireEvent.mouseEnter(row!);
  act(() => vi.advanceTimersByTime(80));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SidebarContextMenus flyout 关闭语义（F7-F12）', () => {
  it('鼠标移出行后 flyout 关闭', () => {
    vi.useFakeTimers();
    renderSortMenu();
    openFlyout('排序方式');
    expect(screen.getByRole('group', { name: '排序方式' })).toBeInTheDocument();
    const row = screen.getByText('排序方式').closest('div')!;
    fireEvent.mouseLeave(row);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole('group', { name: '排序方式' })).not.toBeInTheDocument();
  });

  it('鼠标移入 flyout 内部不误关（宽限期容错）', () => {
    vi.useFakeTimers();
    renderSortMenu();
    openFlyout('分组方式');
    const flyout = screen.getByRole('group', { name: '分组方式' });
    const row = screen.getByText('分组方式').closest('div')!;
    fireEvent.mouseLeave(row);
    fireEvent.mouseEnter(flyout);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole('group', { name: '分组方式' })).toBeInTheDocument();
    // 移出 flyout 后关闭
    fireEvent.mouseLeave(flyout);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole('group', { name: '分组方式' })).not.toBeInTheDocument();
  });

  it('ArrowLeft 关闭 flyout 且不关闭整个排序菜单（F7-F12）', () => {
    vi.useFakeTimers();
    const { props } = renderSortMenu();
    openFlyout('列表范围');
    const flyout = screen.getByRole('group', { name: '列表范围' });
    fireEvent.keyDown(flyout, { key: 'ArrowLeft' });
    expect(screen.queryByRole('group', { name: '列表范围' })).not.toBeInTheDocument();
    // 整个排序菜单仍展开
    expect(screen.getByText('排序与过滤')).toBeInTheDocument();
    expect(props.onCloseSortDropdown).not.toHaveBeenCalled();
  });

  it('Esc 关闭 flyout 且不关闭整个排序菜单（F7-F12）', () => {
    vi.useFakeTimers();
    const { props } = renderSortMenu();
    openFlyout('排序方式');
    const flyout = screen.getByRole('group', { name: '排序方式' });
    fireEvent.keyDown(flyout, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: '排序方式' })).not.toBeInTheDocument();
    expect(screen.getByText('排序与过滤')).toBeInTheDocument();
    expect(props.onCloseSortDropdown).not.toHaveBeenCalled();
  });

  it('ArrowRight 打开 flyout 并聚焦首项（键盘可达）', () => {
    vi.useFakeTimers();
    renderSortMenu();
    const row = screen.getByText('排序方式').closest('div')!;
    fireEvent.keyDown(row, { key: 'ArrowRight' });
    // 聚焦经 rAF 派发（fake timers 下显式推进）
    act(() => vi.advanceTimersByTime(20));
    const flyout = screen.getByRole('group', { name: '排序方式' });
    const firstOption = screen.getByRole('menuitemradio', { name: /按最近活跃/ });
    expect(flyout).toBeInTheDocument();
    expect(firstOption).toHaveFocus();
  });

  it('行可聚焦（tabIndex 可达）——键盘用户能到达子菜单入口', () => {
    renderSortMenu();
    const row = screen.getByText('排序方式').closest('div')!;
    expect(row.tabIndex).toBe(0);
    expect(row).toHaveAttribute('role', 'menuitem');
  });
});
