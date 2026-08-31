// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppTopBar } from './AppTopBar';
import {
  useWorkspaceShellStore,
  createDefaultDock,
} from '../../store/workspace-shell';
import { useSessionStore } from '../../store/sessionStore';
import { GENERAL_FOLDER } from '../../api/projectStore';
import type { SessionState } from '../../store/types';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const openNewDraftTab = vi.fn();

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
      openNewDraftTab,
      getState: () => useWorkspaceShellStore.getState(),
    },
    tree: {
      getState: () => ({}),
    },
  }),
}));

const dock = () => createDefaultDock();

function seedNamedSession(): void {
  const sess: SessionState = {
    id: 'sess-a',
    title: '缓存优化方案',
    folder: GENERAL_FOLDER,
    isPinned: false,
    isArchived: false,
    timestamp: '',
    messages: [],
  };
  useSessionStore.setState({
    sessions: [sess],
    sessionsById: { 'sess-a': sess },
  });
  useWorkspaceShellStore.setState({
    openTabs: [
      {
        tabId: 'tab-a',
        kind: 'conversation',
        sessionId: 'sess-a',
        workspaceKey: GENERAL_FOLDER,
        title: '未命名会话',
        rightDock: dock(),
      },
    ],
    activeTabId: 'tab-a',
    shellReady: true,
  });
}

describe('AppTopBar', () => {
  const onToggleSidebar = vi.fn();
  const onShowCheatsheet = vi.fn();

  const renderBar = () =>
    render(
      <AppTopBar
        sidebarCollapsed={false}
        sidebarWidth={260}
        onToggleSidebar={onToggleSidebar}
        onShowCheatsheet={onShowCheatsheet}
      />
    );

  beforeEach(() => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      configurable: true,
    });
    onToggleSidebar.mockClear();
    onShowCheatsheet.mockClear();
    openNewDraftTab.mockClear();
    useSessionStore.setState({
      sessions: [],
      sessionsById: {},
    });
    useWorkspaceShellStore.setState({
      openTabs: [],
      activeTabId: null,
      shellReady: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders 36px seamless topbar with banner role', () => {
    const { getByRole } = renderBar();

    const banner = getByRole('banner');
    expect(banner).toBeTruthy();
    expect(banner.getAttribute('aria-label')).toBe('应用顶栏');
  });

  it('toggles sidebar on sidebar button click', () => {
    const { getByTestId } = renderBar();

    const toggleBtn = getByTestId('sidebar-toggle');
    fireEvent.click(toggleBtn);
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
  });

  it('rail 是固定槽位：侧栏开合不改变侧栏开关按钮的位置', () => {
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
    // 非 mac 环境固定 48px；不再跟随 sidebarWidth
    expect(rail.style.width).toBe('48px');
    // 负边距补偿已随固定槽位一并退役
    expect(rail.style.marginRight).toBe('');

    rerender(
      <AppTopBar
        sidebarCollapsed={true}
        sidebarWidth={280}
        onToggleSidebar={onToggleSidebar}
        onShowCheatsheet={onShowCheatsheet}
      />
    );

    // 收起侧栏后宽度不变——按钮钉在原地，鼠标不用追
    expect(rail.style.width).toBe('48px');
    expect(rail.style.marginRight).toBe('');
  });

  it('help button triggers onShowCheatsheet and dispatches open-cheatsheet event', () => {
    const eventHandler = vi.fn();
    window.addEventListener('open-cheatsheet', eventHandler);

    const { getByLabelText } = renderBar();

    const helpBtn = getByLabelText('快捷键与帮助');
    fireEvent.click(helpBtn);

    expect(onShowCheatsheet).toHaveBeenCalledTimes(1);
    expect(eventHandler).toHaveBeenCalledTimes(1);

    window.removeEventListener('open-cheatsheet', eventHandler);
  });

  it('add session button dispatches app:new-session event', () => {
    const eventHandler = vi.fn();
    window.addEventListener('app:new-session', eventHandler);

    const { getByTestId } = renderBar();

    const addBtn = getByTestId('global-strip-new-session');
    expect(addBtn.getAttribute('aria-label')).toBe('新建对话');
    fireEvent.click(addBtn);

    expect(eventHandler).toHaveBeenCalledTimes(1);

    window.removeEventListener('app:new-session', eventHandler);
  });

  it('加号走 openNewDraftTab，不走演示 addTab', () => {
    const { getByTestId } = renderBar();
    fireEvent.click(getByTestId('global-strip-new-session'));
    expect(openNewDraftTab).toHaveBeenCalledTimes(1);
  });

  it('非 Mac 保留真窗控：最小化 / 最大化 / 关闭', () => {
    const { getByLabelText } = renderBar();
    expect(getByLabelText('快捷键与帮助')).toBeTruthy();
    expect(getByLabelText('最小化窗口')).toBeTruthy();
    expect(getByLabelText('最大化窗口')).toBeTruthy();
    expect(getByLabelText('关闭应用')).toBeTruthy();
  });

  it('可点钮不贴无 CSS 的 no-drag class', () => {
    const { getByTestId, getByLabelText } = renderBar();
    expect(getByTestId('sidebar-toggle').className).not.toMatch(/\bno-drag\b/);
    expect(getByLabelText('快捷键与帮助').className).not.toMatch(/\bno-drag\b/);
    expect(getByTestId('global-strip-new-session').className).not.toMatch(
      /\bno-drag\b/
    );
  });

  it('胶囊标题走会话投影，不写死未命名会话', () => {
    seedNamedSession();
    const { getAllByTestId } = renderBar();
    const tabs = getAllByTestId('global-session-tab');
    expect(tabs[0]!.textContent).toContain('缓存优化方案');
    expect(tabs[0]!.textContent).not.toContain('未命名会话');
  });

  it('顶栏 CSS：画布底、无 secondary 二次底、无 0.5px 实线底边', () => {
    const css = readFileSync(join(DIR, 'AppTopBar.module.css'), 'utf8');
    expect(css).toMatch(/background:\s*var\(--bg-workspace/);
    expect(css).not.toMatch(/background:\s*var\(--bg-secondary\)/);
    expect(css).not.toMatch(/border-bottom:\s*0\.5px/);
  });

  it('窗控关闭悬停仍是产品红 #e81123', () => {
    const css = readFileSync(
      join(DIR, '../shell/WindowControls.module.css'),
      'utf8'
    );
    expect(css).toContain('#e81123');
  });
});
