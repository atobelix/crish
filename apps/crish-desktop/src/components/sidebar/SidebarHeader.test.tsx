// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { SidebarHeader, SidebarToggle } from './SidebarHeader';

vi.mock('./SidebarNav', () => ({
  SidebarNav: () => <div data-testid="sidebar-nav-stub" />,
}));

const headerProps = {
  sidebarBehavior: 'push',
  isOverlayActive: false,
  chromeHidden: false,
  searchStatusText: '',
  filterType: 'all',
  isSearching: false,
  filterLabel: '全部会话',
  activeNav: 'new',
  onHamburgerClick: vi.fn(),
  onOverlayClose: vi.fn(),
  onNewSession: vi.fn(),
  onOpenScheduled: vi.fn(),
};

describe('SidebarToggle', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('开关挂在 sidebar-header 槽里，点击切换侧栏', () => {
    const onToggle = vi.fn();
    const { getByTestId, container } = render(
      <SidebarToggle collapsed={false} onToggle={onToggle} />
    );

    const header = container.querySelector('.sidebar-header');
    expect(header).toBeTruthy();
    const btn = getByTestId('sidebar-toggle');
    expect(header?.contains(btn)).toBe(true);
    expect(btn.className).toMatch(/sidebar-toggle-btn/);
    expect(btn.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('收起后开关仍在 header 槽，标签改为展开', () => {
    const { getByTestId, rerender } = render(
      <SidebarToggle collapsed onToggle={vi.fn()} />
    );
    const btn = getByTestId('sidebar-toggle');
    expect(btn.getAttribute('aria-label')).toBe('展开侧栏');
    expect(btn.getAttribute('aria-expanded')).toBe('false');

    rerender(<SidebarToggle collapsed={false} onToggle={vi.fn()} />);
    expect(getByTestId('sidebar-toggle').getAttribute('aria-label')).toBe(
      '收起侧栏'
    );
  });
});

describe('SidebarHeader', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('侧栏头渲染语义化 header，包含折叠按钮与预留扩展区域', () => {
    const onToggle = vi.fn();
    const { getByTestId, container } = render(
      <SidebarHeader {...headerProps} collapsed={false} onToggle={onToggle} />
    );

    const header = container.querySelector('header');
    expect(header).toBeTruthy();
    expect(header?.getAttribute('role')).toBe('banner');

    const toggleBtn = getByTestId('sidebar-header-toggle');
    expect(toggleBtn).toBeTruthy();
    expect(toggleBtn.getAttribute('aria-label')).toBe('收起侧栏');
    fireEvent.click(toggleBtn);
    expect(onToggle).toHaveBeenCalledTimes(1);

    const extra = getByTestId('sidebar-header-extra');
    expect(extra).toBeTruthy();

    const brandIcon = toggleBtn.querySelector(
      '[data-testid="toggle-brand-icon"]'
    );
    expect(brandIcon).toBeTruthy();

    const brandTitle = getByTestId('sidebar-brand-title');
    expect(brandTitle).toBeTruthy();
    expect(brandTitle.textContent).toBe('Crish');
  });
});
