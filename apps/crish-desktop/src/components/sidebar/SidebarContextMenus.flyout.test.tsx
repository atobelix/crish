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
 *
 * 2026-11-02 收敛适配：级联引擎由手写 FlyoutRow/FlyoutOption 换为 ui/Menu 的
 * Base UI 子菜单原语——子菜单容器 role 由 group 改为 menu（无障碍名含行标签），
 * 悬停/关闭时序断言沿用原 80ms 打开 / 150ms 宽限契约（SubmenuTrigger 的
 * delay/closeDelay 属性）；悬停打开另需菜单先收到 mousemove 武装
 * （allowMouseEnter），openFlyout 已显式模拟；行 tabindex 为 Base UI 漫游
 * 模型，以初始焦点落位后的激活态断言。
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
  waitFor,
} from '@testing-library/react';
import { SidebarContextMenus } from './SidebarContextMenus';
import { SessionContextMenu } from './SessionContextMenu';
import { ProjectsSection } from './session-list/ProjectsSection';
import { GeneralSection } from './session-list/GeneralSection';
import { useSessionSearch } from './session-list/useSessionSearch';
import { useSessionGrouping } from './session-list/useSessionGrouping';
import type { SessionState } from '../../store/types';
import type { ProjectEntry } from '../../api/projectStore';

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
  // Base UI 悬停武装：菜单 Popup 的 onMouseMove 置 allowMouseEnter 后，
  // 子菜单触发器的悬停打开才生效（真实指针天然满足，jsdom 需显式模拟）。
  fireEvent.mouseMove(row!);
  fireEvent.mouseEnter(row!);
  act(() => vi.advanceTimersByTime(80));
}

/** 子菜单容器（Base UI Popup，role=menu，无障碍名源自行触发器文本） */
function querySubmenu(label: string) {
  return screen.queryByRole('menu', { name: new RegExp(label) });
}
function getSubmenu(label: string) {
  return screen.getByRole('menu', { name: new RegExp(label) });
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
    expect(getSubmenu('排序方式')).toBeInTheDocument();
    // 指针离开当前行进入另一行：原 flyout 关闭、新行 flyout 打开。
    // 注：jsdom 零几何下 Base UI 安全多边形无法表达「移出到菜单外空白处」
    // 的轨迹关闭，该路径由真机（Tauri MCP 原生鼠标）验收覆盖；
    // 此处以行间移动表达「指针离开当前子菜单区域即关闭」的引擎语义。
    openFlyout('分组方式');
    expect(querySubmenu('排序方式')).not.toBeInTheDocument();
    expect(getSubmenu('分组方式')).toBeInTheDocument();
  });

  it('鼠标移入 flyout 内部不误关（宽限期容错）', () => {
    vi.useFakeTimers();
    renderSortMenu();
    openFlyout('分组方式');
    const flyout = getSubmenu('分组方式');
    const row = screen.getByText('分组方式').closest('div')!;
    fireEvent.mouseLeave(row);
    fireEvent.mouseEnter(flyout);
    act(() => vi.advanceTimersByTime(200));
    expect(getSubmenu('分组方式')).toBeInTheDocument();
    // 移出 flyout 进入另一行后关闭（同上：行间移动表达离开语义）
    openFlyout('排序方式');
    expect(querySubmenu('分组方式')).not.toBeInTheDocument();
    expect(getSubmenu('排序方式')).toBeInTheDocument();
  });

  it('ArrowLeft 关闭 flyout 且不关闭整个排序菜单（F7-F12）', () => {
    vi.useFakeTimers();
    const { props } = renderSortMenu();
    openFlyout('列表范围');
    const flyout = getSubmenu('列表范围');
    fireEvent.keyDown(flyout, { key: 'ArrowLeft' });
    act(() => vi.advanceTimersByTime(30));
    expect(querySubmenu('列表范围')).not.toBeInTheDocument();
    // 整个排序菜单仍展开
    expect(screen.getByText('排序方式')).toBeInTheDocument();
    expect(props.onCloseSortDropdown).not.toHaveBeenCalled();
  });

  it('Esc 关闭 flyout 且不关闭整个排序菜单（F7-F12）', () => {
    vi.useFakeTimers();
    const { props } = renderSortMenu();
    openFlyout('排序方式');
    const flyout = getSubmenu('排序方式');
    fireEvent.keyDown(flyout, { key: 'Escape' });
    act(() => vi.advanceTimersByTime(30));
    expect(querySubmenu('排序方式')).not.toBeInTheDocument();
    expect(screen.getByText('排序方式')).toBeInTheDocument();
    expect(props.onCloseSortDropdown).not.toHaveBeenCalled();
  });

  it('ArrowRight 打开 flyout 并聚焦首项（键盘可达）', () => {
    vi.useFakeTimers();
    renderSortMenu();
    // 初始焦点经 rAF 落到首行（组件打开副作用，fake timers 下显式推进）
    act(() => vi.advanceTimersByTime(20));
    const row = screen.getByText('排序方式').closest('div')!;
    // 键盘用户的焦点本就在行上（打开时初始焦点落首行）；jsdom 下显式落焦等价模拟
    row.focus();
    fireEvent.keyDown(row, { key: 'ArrowRight' });
    act(() => vi.advanceTimersByTime(20));
    const flyout = getSubmenu('排序方式');
    const firstOption = screen.getByRole('menuitemradio', {
      name: /按最近活跃/,
    });
    expect(flyout).toBeInTheDocument();
    expect(firstOption).toHaveFocus();
  });

  it('行可聚焦（tabIndex 可达）——键盘用户能到达子菜单入口', async () => {
    renderSortMenu();
    const row = screen.getByText('排序方式').closest('div')!;
    expect(row).toHaveAttribute('role', 'menuitem');
    // Base UI 漫游 tabindex：未激活行 -1；组件初始焦点落位后首行成为
    // 激活项（tabIndex 0 且获得焦点），键盘用户由此到达子菜单入口。
    await waitFor(() => expect(document.activeElement).toBe(row));
    expect(row.tabIndex).toBe(0);
  });

  it('展示当前选值摘要并支持点击切换及选择回调', () => {
    const { props } = renderSortMenu();
    expect(screen.getByText('按最近活跃')).toBeInTheDocument();
    expect(screen.getByText('按项目分组')).toBeInTheDocument();
    expect(screen.getByText('全部会话')).toBeInTheDocument();

    const sortRow = screen.getByText('排序方式').closest('div')!;
    fireEvent.click(sortRow);
    expect(getSubmenu('排序方式')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /按名称/ }));
    expect(props.onSetSortType).toHaveBeenCalledWith('name');
  });

  it('ProjectsSection 将 sectionSortBtn 置于 sectionNew（新建项目）左侧，支持新建项目与已建项目 More 管理弹出面板；平铺模式下由 GeneralSection 承载', async () => {
    const onOpenProject = vi.fn();
    const { unmount } = render(
      <ProjectsSection
        data={{
          projects: [
            {
              id: 'proj-demo',
              name: 'DemoProj',
              path: 'C:/workspace/DemoProj',
              addedAt: 1,
              lastOpenedAt: 2,
            },
          ],
          collapsedProjects: {},
          projectsSectionCollapsed: false,
          byProjectId: {},
        }}
        actions={{
          onToggleProjectsSection: vi.fn(),
          onToggleProjectCollapsed: vi.fn(),
          onOpenProject,
          onSortBtnClick: vi.fn(),
          sortTriggerRef: React.createRef<HTMLButtonElement>(),
          sortDropdownOpen: false,
          onMoveSessionRealtime: vi.fn(),
          renderSessionItem: () => null,
        }}
      />
    );
    const sortBtn = screen.getByRole('button', { name: '排序与过滤' });
    const newProjBtn = screen.getByRole('button', { name: '新建项目' });
    expect(sortBtn.parentElement).toBe(newProjBtn.parentElement);
    const siblings = Array.from(sortBtn.parentElement!.children);
    expect(siblings.indexOf(sortBtn)).toBeLessThan(
      siblings.indexOf(newProjBtn)
    );

    // 已建立项目行：More 按钮在「在本项目新建对话」按钮左侧
    const projMoreBtn = screen.getByRole('button', {
      name: '项目 DemoProj 更多操作',
    });
    const projNewChatBtn = screen.getByRole('button', {
      name: '在 DemoProj 新建对话',
    });
    expect(projMoreBtn.parentElement).toBe(projNewChatBtn.parentElement);
    const projActionSiblings = Array.from(projMoreBtn.parentElement!.children);
    expect(projActionSiblings.indexOf(projMoreBtn)).toBeLessThan(
      projActionSiblings.indexOf(projNewChatBtn)
    );

    // 点击「新建项目」展开居中弹出面板，显示选择文件夹与项目名称
    fireEvent.click(newProjBtn);
    expect(
      await screen.findByRole('dialog', { name: '新建项目' })
    ).toBeInTheDocument();
    expect(screen.getByText('点击选择项目文件夹')).toBeInTheDocument();
    const nameInput = screen.getByLabelText('项目名称');
    expect(nameInput).toBeInTheDocument();

    // 点击已建立项目的 More 按钮，展开项目管理与扩展功能面板
    fireEvent.click(projMoreBtn);
    expect(
      await screen.findByRole('dialog', { name: '项目管理' })
    ).toBeInTheDocument();
    const manageNameInput = screen.getByDisplayValue('DemoProj');
    expect(manageNameInput).toBeInTheDocument();
    expect(screen.getByText('C:/workspace/DemoProj')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '在本项目新建对话' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '设为当前工作区' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '复制文件夹路径' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '从列表移除项目' })
    ).toBeInTheDocument();
    unmount();

    // 分组模式下 GeneralSection 不渲染重复的排序按钮
    const { rerender } = render(
      <GeneralSection
        generalSessions={[]}
        generalCollapsed={false}
        generalWindowEnabled={false}
        generalRenderRange={{
          start: 0,
          end: 0,
          topPadPx: 0,
          bottomPadPx: 0,
          windowed: false,
        }}
        generalListRef={React.createRef<HTMLUListElement>()}
        groupType="folder"
        onToggleGeneral={vi.fn()}
        onSortBtnClick={vi.fn()}
        onMoveSessionRealtime={vi.fn()}
        renderSessionItem={() => null}
      />
    );
    expect(
      screen.queryByRole('button', { name: '排序与过滤' })
    ).not.toBeInTheDocument();

    // 平铺模式（纯对话）下 GeneralSection 顶行右侧渲染「排序与过滤」于「新建常规对话」左侧
    rerender(
      <GeneralSection
        generalSessions={[]}
        generalCollapsed={false}
        generalWindowEnabled={false}
        generalRenderRange={{
          start: 0,
          end: 0,
          topPadPx: 0,
          bottomPadPx: 0,
          windowed: false,
        }}
        generalListRef={React.createRef<HTMLUListElement>()}
        groupType="none"
        onToggleGeneral={vi.fn()}
        onSortBtnClick={vi.fn()}
        onMoveSessionRealtime={vi.fn()}
        renderSessionItem={() => null}
      />
    );
    const flatSortBtn = screen.getByRole('button', { name: '排序与过滤' });
    const newChatBtn = screen.getByRole('button', { name: '新建常规对话' });
    expect(flatSortBtn.parentElement).toBe(newChatBtn.parentElement);
    const flatSiblings = Array.from(flatSortBtn.parentElement!.children);
    expect(flatSiblings.indexOf(flatSortBtn)).toBeLessThan(
      flatSiblings.indexOf(newChatBtn)
    );
  });

  it('实装 sortType / groupType / filterType 的完整排序、分组与过滤语义', () => {
    const projects: ProjectEntry[] = [
      { id: 'proj-1', name: 'Conex', path: '/conex', addedAt: 1000 },
    ];
    const sessions: SessionState[] = [
      {
        id: 's-b',
        title: 'Beta 会话',
        folder: 'proj-1',
        isPinned: false,
        timestamp: '2026-01-01T00:00:01.000Z',
        messages: [],
      },
      {
        id: 's-a',
        title: 'Alpha 会话',
        folder: 'general',
        isPinned: false,
        timestamp: '2026-01-01T00:00:03.000Z',
        messages: [],
      },
      {
        id: 's-p',
        title: 'Pinned 会话',
        folder: 'general',
        isPinned: true,
        timestamp: '2026-01-01T00:00:02.000Z',
        messages: [],
      },
    ];

    // 1. sortType = 'active', groupType = 'folder', filterType = 'all'
    const { result: searchActive } = renderHook(() =>
      useSessionSearch({
        visibleSessions: sessions,
        searchQuery: '',
        sortType: 'active',
      })
    );
    expect(searchActive.current.sortedSessions.map((s) => s.id)).toEqual([
      's-a',
      's-p',
      's-b',
    ]);

    const { result: groupFolder } = renderHook(() =>
      useSessionGrouping({
        sortedSessions: searchActive.current.sortedSessions,
        projects,
        groupType: 'folder',
        filterType: 'all',
        dragPreview: null,
        dragSession: null,
        isDragging: false,
        pinnedCollapsed: false,
        onTogglePinned: vi.fn(),
      })
    );
    expect(groupFolder.current.pinnedSessions.map((s) => s.id)).toEqual([
      's-p',
    ]);
    expect(groupFolder.current.byProjectId['proj-1']?.map((s) => s.id)).toEqual(
      ['s-b']
    );
    expect(groupFolder.current.generalSessions.map((s) => s.id)).toEqual([
      's-a',
    ]);

    // 2. sortType = 'name', groupType = 'none' (平铺列表：合并项目与常规会话并按名称排序)
    const { result: searchName } = renderHook(() =>
      useSessionSearch({
        visibleSessions: sessions,
        searchQuery: '',
        sortType: 'name',
      })
    );
    const { result: groupNone } = renderHook(() =>
      useSessionGrouping({
        sortedSessions: searchName.current.sortedSessions,
        projects,
        groupType: 'none',
        filterType: 'all',
        dragPreview: null,
        dragSession: null,
        isDragging: false,
        pinnedCollapsed: false,
        onTogglePinned: vi.fn(),
      })
    );
    expect(groupNone.current.byProjectId['proj-1']).toEqual([]);
    expect(groupNone.current.generalSessions.map((s) => s.id)).toEqual([
      's-a',
      's-b',
    ]);
  });

  it('SessionContextMenu 弹出面板同步具备 Base UI 打开态（data-open）与 data-side 动画属性', () => {
    render(
      <SessionContextMenu
        contextMenu={{ x: 120, y: 180, sessionId: 's-1' }}
        menuRef={React.createRef<HTMLDivElement>()}
        isPinned={false}
        onSessionAction={vi.fn()}
      />
    );
    const menu = screen.getByTestId('session-context-menu');
    // 收敛适配：Base UI 1.9 的打开态标记为 data-open（旧手写面板为 data-state）
    expect(menu).toHaveAttribute('data-open');
    expect(menu).toHaveAttribute('data-side');
  });
});
