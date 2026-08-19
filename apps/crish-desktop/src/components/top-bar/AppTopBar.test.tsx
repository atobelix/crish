// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { AppTopBar } from './AppTopBar';
import { useWorkspaceShellStore } from '../../store/workspace-shell';

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    isMaximized: vi.fn().mockResolvedValue(false),
    onResized: vi.fn().mockResolvedValue(() => {}),
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock('../../app/compositionRoot', () => ({
  getCompositionRoot: () => ({
    shell: {
      openNewDraftTab: vi.fn(),
      getState: () => useWorkspaceShellStore.getState(),
    },
    tree: {
      getState: () => ({}),
    },
  }),
}));

describe('AppTopBar', () => {
  const onToggleSidebar = vi.fn();
  const onShowCheatsheet = vi.fn();

  beforeEach(() => {
    onToggleSidebar.mockClear();
    onShowCheatsheet.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders 36px seamless topbar with banner role', () => {
    const { getByRole } = render(
      <AppTopBar
        sidebarCollapsed={false}
        sidebarWidth={260}
        onToggleSidebar={onToggleSidebar}
        onShowCheatsheet={onShowCheatsheet}
      />
    );

    const banner = getByRole('banner');
    expect(banner).toBeTruthy();
    expect(banner.getAttribute('aria-label')).toBe('应用顶栏');
  });

  it('toggles sidebar on sidebar button click', () => {
    const { getByTestId } = render(
      <AppTopBar
        sidebarCollapsed={false}
        sidebarWidth={260}
        onToggleSidebar={onToggleSidebar}
        onShowCheatsheet={onShowCheatsheet}
      />
    );

    const toggleBtn = getByTestId('sidebar-toggle');
    fireEvent.click(toggleBtn);
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
  });

  it('rail reflects sidebarCollapsed state and -16px margin compensation', () => {
    const { container, rerender } = render(
      <AppTopBar
        sidebarCollapsed={false}
        sidebarWidth={280}
        onToggleSidebar={onToggleSidebar}
        onShowCheatsheet={onShowCheatsheet}
      />
    );

    const rail = container.querySelector('.app-top-bar__rail') as HTMLElement;
    expect(rail).toBeTruthy();
    expect(rail.style.width).toBe('280px');
    expect(rail.style.marginRight).toBe('-16px');

    rerender(
      <AppTopBar
        sidebarCollapsed={true}
        sidebarWidth={280}
        onToggleSidebar={onToggleSidebar}
        onShowCheatsheet={onShowCheatsheet}
      />
    );

    expect(rail.style.width).toBe('36px');
    expect(rail.style.marginRight).toBe('0px');
  });

  it('help button triggers onShowCheatsheet and dispatches open-cheatsheet event', () => {
    const eventHandler = vi.fn();
    window.addEventListener('open-cheatsheet', eventHandler);

    const { getByLabelText } = render(
      <AppTopBar
        sidebarCollapsed={false}
        sidebarWidth={260}
        onToggleSidebar={onToggleSidebar}
        onShowCheatsheet={onShowCheatsheet}
      />
    );

    const helpBtn = getByLabelText('快捷键与帮助');
    fireEvent.click(helpBtn);

    expect(onShowCheatsheet).toHaveBeenCalledTimes(1);
    expect(eventHandler).toHaveBeenCalledTimes(1);

    window.removeEventListener('open-cheatsheet', eventHandler);
  });

  it('add session button dispatches app:new-session event', () => {
    const eventHandler = vi.fn();
    window.addEventListener('app:new-session', eventHandler);

    const { getByTestId } = render(
      <AppTopBar
        sidebarCollapsed={false}
        sidebarWidth={260}
        onToggleSidebar={onToggleSidebar}
        onShowCheatsheet={onShowCheatsheet}
      />
    );

    const addBtn = getByTestId('global-strip-new-session');
    expect(addBtn.getAttribute('aria-label')).toBe('新建对话');
    fireEvent.click(addBtn);

    expect(eventHandler).toHaveBeenCalledTimes(1);

    window.removeEventListener('app:new-session', eventHandler);
  });
});
