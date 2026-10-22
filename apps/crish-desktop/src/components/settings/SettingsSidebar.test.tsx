// @vitest-environment jsdom
/**
 * SettingsSidebar 用户视角测试：分类 tablist 的选中/roving 语义、点击与聚焦回调、
 * 搜索输入与清空、空结果态、读屏状态播报。使用真实 TAB_META，不 mock 子组件。
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SettingsSidebar, type SettingsSidebarProps } from './SettingsSidebar';
import { TAB_META } from '../settingsTabsMeta';

const ITEMS = TAB_META.slice(0, 4);

function renderSidebar(
  overrides: Partial<SettingsSidebarProps> = {},
  searchQuery = ''
) {
  const onSelect = vi.fn();
  const onFocusTab = vi.fn();
  const onTablistKeyDown = vi.fn();
  const onSearchChange = vi.fn();
  const onSearchKeyDown = vi.fn();
  const searchInputRef = React.createRef<HTMLInputElement>();
  const props: SettingsSidebarProps = {
    items: ITEMS,
    activeId: ITEMS[1]!.id,
    rovingId: ITEMS[1]!.id,
    onTablistKeyDown,
    onSelect,
    onFocusTab,
    aria: {
      baseId: 'st',
      tablistId: 'st-list',
      searchId: 'st-search',
      statusId: 'st-status',
      panelId: 'st-panel',
      tablistRef: React.createRef<HTMLDivElement>(),
    },
    search: {
      searchQuery,
      filterStatusText: '',
      searchInputRef,
      onSearchChange,
      onSearchKeyDown,
    },
    ...overrides,
  };
  const utils = render(<SettingsSidebar {...props} />);
  return {
    ...utils,
    onSelect,
    onFocusTab,
    onTablistKeyDown,
    onSearchChange,
    onSearchKeyDown,
    searchInputRef,
  };
}

afterEach(() => cleanup());

describe('SettingsSidebar 分类导航', () => {
  it('每个分类渲染为 tab，仅当前项 aria-selected 且关联面板、仅 roving 项可 Tab 聚焦', () => {
    renderSidebar();
    const tablist = screen.getByRole('tablist');
    expect(tablist).toHaveAttribute('aria-orientation', 'vertical');
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(ITEMS.length);

    const selected = tabs.filter(
      (tab) => tab.getAttribute('aria-selected') === 'true'
    );
    expect(selected).toEqual([tabs[1]]);
    expect(tabs[1]).toHaveAttribute('aria-controls', 'st-panel');
    expect(tabs[0]).not.toHaveAttribute('aria-controls');
    expect(tabs.map((tab) => tab.getAttribute('tabindex'))).toEqual([
      '-1',
      '0',
      '-1',
      '-1',
    ]);
  });

  it('tab 的可访问名称包含分组与分类名', () => {
    renderSidebar();
    const [first] = screen.getAllByRole('tab');
    expect(first!.getAttribute('aria-label')).toMatch(/ · /);
    expect(first).toHaveTextContent(
      first!.getAttribute('aria-label')!.split(' · ')[1]!
    );
  });

  it('点击 tab 以其 id 调用 onSelect，聚焦调用 onFocusTab', () => {
    const { onSelect, onFocusTab } = renderSidebar();
    const tabs = screen.getAllByRole('tab');
    fireEvent.click(tabs[2]!);
    expect(onSelect).toHaveBeenCalledWith(ITEMS[2]!.id);
    fireEvent.focus(tabs[3]!);
    expect(onFocusTab).toHaveBeenCalledWith(ITEMS[3]!.id);
  });

  it('tablist 上的键盘事件交给 onTablistKeyDown 处理', () => {
    const { onTablistKeyDown } = renderSidebar();
    fireEvent.keyDown(screen.getAllByRole('tab')[1]!, { key: 'ArrowDown' });
    expect(onTablistKeyDown).toHaveBeenCalledTimes(1);
    expect(onTablistKeyDown.mock.calls[0]![0].key).toBe('ArrowDown');
  });

  it('无匹配分类时在 tablist 内显示空结果状态', () => {
    renderSidebar({ items: [] });
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    const tablist = screen.getByRole('tablist');
    const empty = screen
      .getAllByRole('status')
      .find((el) => tablist.contains(el));
    expect(empty).toBeDefined();
    expect(empty!.textContent!.trim().length).toBeGreaterThan(0);
  });
});

describe('SettingsSidebar 搜索', () => {
  it('输入把新值交给 onSearchChange；无查询时不显示清空按钮', () => {
    const { onSearchChange } = renderSidebar();
    const box = screen.getByRole('searchbox');
    expect(box).toHaveAttribute('aria-controls', 'st-list');
    fireEvent.change(box, { target: { value: '模型' } });
    expect(onSearchChange).toHaveBeenCalledWith('模型');
    expect(
      screen.queryByRole('button', { name: /清空搜索|Clear/i })
    ).toBeNull();
  });

  it('有查询时显示清空按钮，点击后清空并把焦点放回搜索框', () => {
    const { onSearchChange, searchInputRef } = renderSidebar({}, '模型');
    fireEvent.click(screen.getByRole('button', { name: /清空搜索|Clear/i }));
    expect(onSearchChange).toHaveBeenCalledWith('');
    expect(document.activeElement).toBe(searchInputRef.current);
  });

  it('点击搜索区域任意位置聚焦输入框；按键交给 onSearchKeyDown', () => {
    const { onSearchKeyDown, searchInputRef } = renderSidebar();
    fireEvent.click(screen.getByRole('search'));
    expect(document.activeElement).toBe(searchInputRef.current);
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });
    expect(onSearchKeyDown).toHaveBeenCalledTimes(1);
  });

  it('筛选状态文本通过 polite live region 播报', () => {
    renderSidebar({
      search: {
        searchQuery: 'x',
        filterStatusText: '找到 2 个分类',
        searchInputRef: React.createRef<HTMLInputElement>(),
        onSearchChange: vi.fn(),
        onSearchKeyDown: vi.fn(),
      },
    });
    const live = screen.getByText('找到 2 个分类');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveAttribute('id', 'st-status');
  });
});
