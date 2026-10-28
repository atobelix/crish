// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import {
  SidebarHeader,
  SidebarToggle,
  resetSidebarMorphState,
} from './SidebarHeader';

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
    resetSidebarMorphState();
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

  it('折叠态开关外层与按钮均挂载 data-tauri-drag-region="false" 阻止指针跳变', () => {
    const { getByTestId, container } = render(
      <SidebarToggle collapsed onToggle={vi.fn()} />
    );
    const header = container.querySelector('.sidebar-header');
    expect(header?.getAttribute('data-tauri-drag-region')).toBe('false');
    const btn = getByTestId('sidebar-toggle');
    expect(btn.getAttribute('data-tauri-drag-region')).toBe('false');
  });

  it('折叠态悬停顶部区域触发图标动效并在动画结束后平滑复原', () => {
    vi.useFakeTimers();
    try {
      const { getByTestId, container } = render(
        <SidebarToggle collapsed onToggle={vi.fn()} />
      );
      const header = container.querySelector('.sidebar-header')!;
      const btn = getByTestId('sidebar-toggle');
      const morphContainer = btn.querySelector('[data-morphing]');
      expect(morphContainer?.getAttribute('data-morphing')).toBe('false');

      // 悬停顶部区域
      fireEvent.mouseEnter(header);
      expect(
        btn.querySelector('[data-morphing]')?.getAttribute('data-morphing')
      ).toBe('true');

      // 750ms 后自动复原为软件图标
      act(() => {
        vi.advanceTimersByTime(800);
      });
      expect(
        btn.querySelector('[data-morphing]')?.getAttribute('data-morphing')
      ).toBe('false');

      // 再次悬停再次触发
      fireEvent.mouseEnter(header);
      expect(
        btn.querySelector('[data-morphing]')?.getAttribute('data-morphing')
      ).toBe('true');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SidebarHeader', () => {
  afterEach(() => {
    cleanup();
    resetSidebarMorphState();
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
    expect((brandIcon as HTMLElement).style.display).not.toBe('none');

    const brandTitle = getByTestId('sidebar-brand-title');
    expect(brandTitle).toBeTruthy();
    expect(brandTitle.textContent).toBe('Crish');
  });

  it('展开态悬停标题栏或快捷操作区触发动效，移出再进入可重播', () => {
    vi.useFakeTimers();
    try {
      const { getByTestId, container } = render(
        <SidebarHeader {...headerProps} collapsed={false} onToggle={vi.fn()} />
      );
      const header = container.querySelector('header')!;
      const toggleBtn = getByTestId('sidebar-header-toggle');
      const morphContainer = toggleBtn.querySelector('[data-morphing]');
      expect(morphContainer?.getAttribute('data-morphing')).toBe('false');

      // 悬停顶栏
      fireEvent.mouseEnter(header);
      expect(
        toggleBtn
          .querySelector('[data-morphing]')
          ?.getAttribute('data-morphing')
      ).toBe('true');

      // 动画完成超时自动复原
      act(() => {
        vi.advanceTimersByTime(800);
      });
      expect(
        toggleBtn
          .querySelector('[data-morphing]')
          ?.getAttribute('data-morphing')
      ).toBe('false');

      // 悬停快捷操作区（左侧区域）
      const quickActions = container.querySelector('[role="group"]')!;
      fireEvent.mouseEnter(quickActions);
      expect(
        toggleBtn
          .querySelector('[data-morphing]')
          ?.getAttribute('data-morphing')
      ).toBe('true');
    } finally {
      vi.useRealTimers();
    }
  });

  it('全局区域判定：在主区域移动不触发，划入顶部区域或侧栏区域即刻敏捷触发', () => {
    vi.useFakeTimers();
    try {
      const { getByTestId } = render(
        <SidebarHeader {...headerProps} collapsed={false} onToggle={vi.fn()} />
      );
      const toggleBtn = getByTestId('sidebar-header-toggle');
      expect(
        toggleBtn
          .querySelector('[data-morphing]')
          ?.getAttribute('data-morphing')
      ).toBe('false');

      // 1. 鼠标在主区域（Y: 300, X: 500）移动：不触发
      act(() => {
        window.dispatchEvent(
          new MouseEvent('pointermove', {
            clientX: 500,
            clientY: 300,
            bubbles: true,
          })
        );
      });
      expect(
        toggleBtn
          .querySelector('[data-morphing]')
          ?.getAttribute('data-morphing')
      ).toBe('false');

      // 2. 鼠标划入顶部区域（Y: 20 <= 38, X: 500）：即刻触发
      act(() => {
        window.dispatchEvent(
          new MouseEvent('pointermove', {
            clientX: 500,
            clientY: 20,
            bubbles: true,
          })
        );
      });
      expect(
        toggleBtn
          .querySelector('[data-morphing]')
          ?.getAttribute('data-morphing')
      ).toBe('true');

      // 3. 750ms 动效自然结束复原
      act(() => {
        vi.advanceTimersByTime(800);
      });
      expect(
        toggleBtn
          .querySelector('[data-morphing]')
          ?.getAttribute('data-morphing')
      ).toBe('false');

      // 4. 再次在顶部区域微移（鼠标未离开顶部区域）：保持静止不晃动
      act(() => {
        window.dispatchEvent(
          new MouseEvent('pointermove', {
            clientX: 480,
            clientY: 22,
            bubbles: true,
          })
        );
      });
      expect(
        toggleBtn
          .querySelector('[data-morphing]')
          ?.getAttribute('data-morphing')
      ).toBe('false');

      // 5. 鼠标离开移回主区域（Y: 300, X: 500），就绪锁重置
      act(() => {
        window.dispatchEvent(
          new MouseEvent('pointermove', {
            clientX: 500,
            clientY: 300,
            bubbles: true,
          })
        );
      });

      // 6. 再次划入左侧边栏区域（X: 100 <= 260, Y: 300）：即刻再次触发播放
      act(() => {
        window.dispatchEvent(
          new MouseEvent('pointermove', {
            clientX: 100,
            clientY: 300,
            bubbles: true,
          })
        );
      });
      expect(
        toggleBtn
          .querySelector('[data-morphing]')
          ?.getAttribute('data-morphing')
      ).toBe('true');
    } finally {
      vi.useRealTimers();
    }
  });
});
