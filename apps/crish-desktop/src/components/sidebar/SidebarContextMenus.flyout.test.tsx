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
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
  renderHook,
} from '@testing-library/react';
import { SidebarContextMenus } from './SidebarContextMenus';
import { GeneralSection } from './session-list/GeneralSection';
import { useSessionSearch } from './session-list/useSessionSearch';
import { useSessionGrouping } from './session-list/useSessionGrouping';
import type { Session, Project } from '../../types';

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
    expect(
      screen.queryByRole('group', { name: '排序方式' })
    ).not.toBeInTheDocument();
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
    expect(
      screen.queryByRole('group', { name: '分组方式' })
    ).not.toBeInTheDocument();
  });

  it('ArrowLeft 关闭 flyout 且不关闭整个排序菜单（F7-F12）', () => {
    vi.useFakeTimers();
    const { props } = renderSortMenu();
    openFlyout('列表范围');
    const flyout = screen.getByRole('group', { name: '列表范围' });
    fireEvent.keyDown(flyout, { key: 'ArrowLeft' });
    expect(
      screen.queryByRole('group', { name: '列表范围' })
    ).not.toBeInTheDocument();
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
    expect(
      screen.queryByRole('group', { name: '排序方式' })
    ).not.toBeInTheDocument();
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
    const firstOption = screen.getByRole('menuitemradio', {
      name: /按最近活跃/,
    });
    expect(flyout).toBeInTheDocument();
    expect(firstOption).toHaveFocus();
  });

  it('行可聚焦（tabIndex 可达）——键盘用户能到达子菜单入口', () => {
    renderSortMenu();
    const row = screen.getByText('排序方式').closest('div')!;
    expect(row.tabIndex).toBe(0);
    expect(row).toHaveAttribute('role', 'menuitem');
  });

  it('展示当前选值摘要并支持点击切换及选择回调', () => {
    const { props } = renderSortMenu();
    expect(screen.getByText('按最近活跃')).toBeInTheDocument();
    expect(screen.getByText('按项目分组')).toBeInTheDocument();
    expect(screen.getByText('全部会话')).toBeInTheDocument();

    const sortRow = screen.getByText('排序方式').closest('div')!;
    fireEvent.click(sortRow);
    expect(screen.getByRole('group', { name: '排序方式' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /按名称/ }));
    expect(props.onSetSortType).toHaveBeenCalledWith('name');
  });

  it('GeneralSection 将 sectionSortBtn 置于 sectionNew 左侧', () => {
    render(
      <GeneralSection
        generalOpen={true}
        onToggleGeneral={vi.fn()}
        generalSessions={[]}
        activeSessionId={null}
        selectedSessionIds={[]}
        editingSessionId={null}
        editTitle=""
        onSelectSession={vi.fn()}
        onContextMenu={vi.fn()}
        onOpenMore={vi.fn()}
        onChangeTitle={vi.fn()}
        onSaveRename={vi.fn()}
        onCancelRename={vi.fn()}
        onNewChat={vi.fn()}
        sortBtnRef={React.createRef<HTMLButtonElement>()}
        onOpenSortDropdown={vi.fn()}
        sortDropdownOpen={false}
        hasActiveSortFilter={true}
      />
    );
    const sortBtn = screen.getByRole('button', { name: '排序与过滤' });
    const newBtn = screen.getByRole('button', { name: '新建常规对话' });
    expect(sortBtn.parentElement).toBe(newBtn.parentElement);
    const siblings = Array.from(sortBtn.parentElement!.children);
    expect(siblings.indexOf(sortBtn)).toBeLessThan(siblings.indexOf(newBtn));
    expect(sortBtn).toHaveAttribute('data-active', 'true');
  });

  it('实装 sortType / groupType / filterType 的完整排序、分组与过滤语义', () => {
    const projects: Project[] = [
      { id: 'proj-1', name: 'Conex', path: '/conex' },
    ];
    const sessions: Session[] = [
      {
        id: 's-b',
        title: 'Beta 会话',
        updatedAt: 1000,
        messages: [],
        projectId: 'proj-1',
      },
      { id: 's-a', title: 'Alpha 会话', updatedAt: 3000, messages: [] },
      {
        id: 's-p',
        title: 'Pinned 会话',
        updatedAt: 2000,
        messages: [],
        isPinned: true,
      },
    ];

    // 1. sortType = 'active', groupType = 'folder', filterType = 'all'
    const { result: searchActive } = renderHook(() =>
      useSessionSearch(sessions, projects, '', 'active')
    );
    const { result: groupFolder } = renderHook(() =>
      useSessionGrouping(
        searchActive.current.sortedSessions,
        projects,
        'all',
        'folder',
        false,
        ''
      )
    );
    expect(groupFolder.current.pinnedSessions.map((s) => s.id)).toEqual([
      's-p',
    ]);
    expect(
      groupFolder.current.byProjectId.get('proj-1')?.map((s) => s.id)
    ).toEqual(['s-b']);
    expect(groupFolder.current.generalSessions.map((s) => s.id)).toEqual([
      's-a',
    ]);

    // 2. sortType = 'name', groupType = 'none' (平铺列表)
    const { result: searchName } = renderHook(() =>
      useSessionSearch(sessions, projects, '', 'name')
    );
    const { result: groupNone } = renderHook(() =>
      useSessionGrouping(
        searchName.current.sortedSessions,
        projects,
        'all',
        'none',
        false,
        ''
      )
    );
    expect(groupNone.current.byProjectId.size).toBe(0);
    expect(groupNone.current.generalSessions.map((s) => s.id)).toEqual([
      's-a',
      's-b',
    ]);

    // 3. filterType = 'pinned' (仅置顶)
    const { result: filterPinned } = renderHook(() =>
      useSessionGrouping(
        searchActive.current.sortedSessions,
        projects,
        'pinned',
        'folder',
        false,
        ''
      )
    );
    expect(filterPinned.current.pinnedSessions.map((s) => s.id)).toEqual([
      's-p',
    ]);
    expect(filterPinned.current.byProjectId.size).toBe(0);
    expect(filterPinned.current.generalSessions).toEqual([]);
  });

  it('SessionContextMenu (._sessionActionsBtn 弹出面板) 同步具备 data-state="open" 与 data-side 动画属性', () => {
    render(
      <SidebarContextMenus
        menuRef={React.createRef<HTMLDivElement>()}
        sortMenuRef={React.createRef<HTMLDivElement>()}
        contextMenu={{ x: 120, y: 180, sessionId: 's-1' }}
        onSessionAction={vi.fn()}
        sortDropdownOpen={false}
        sortDropdownCoords={{ x: 0, y: 0 }}
        sortType="active"
        groupType="folder"
        filterType="all"
        onSetSortType={vi.fn()}
        onSetGroupType={vi.fn()}
        onSetFilterType={vi.fn()}
      />
    );
    const menu = screen.getByTestId('session-context-menu');
    expect(menu).toHaveAttribute('data-state', 'open');
    expect(menu).toHaveAttribute('data-side');
  });
});
