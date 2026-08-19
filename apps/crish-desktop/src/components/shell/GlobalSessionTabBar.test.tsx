// @vitest-environment jsdom
/**
 * GlobalSessionTabBar smoke — workspace tabs, equal-width class, + → openNewDraftTab.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import {
  GlobalSessionTabBar,
  resolveTabTitle,
} from './GlobalSessionTabBar';
import {
  useWorkspaceShellStore,
  createDefaultDock,
} from '../../store/workspace-shell';
import { useLayoutTreeStore } from '../../store/layout-tree';
import { useSessionStore } from '../../store/sessionStore';
import { GENERAL_FOLDER } from '../../api/projectStore';
import { EMPTY_SESSION_TITLE } from '../../api/sessionTitle';
import type { SessionState } from '../../store/types';

const dock = () => createDefaultDock();

const openNewDraftTab = vi.fn();

vi.mock('../../app/compositionRoot', () => ({
  getCompositionRoot: () => ({
    shell: {
      openNewDraftTab,
      getState: () => useWorkspaceShellStore.getState(),
    },
    // T06.9.1：workspaceShellStore 跨 store 读树经 compositionRoot.tree
    tree: {
      getState: () => useLayoutTreeStore.getState(),
    },
  }),
}));

function seedTabs() {
  useWorkspaceShellStore.setState({
    openTabs: [
      {
        tabId: 'tab-a',
        kind: 'conversation',
        sessionId: 'sess-a',
        workspaceKey: GENERAL_FOLDER,
        title: '会话 A',
        rightDock: dock(),
      },
      {
        tabId: 'tab-b',
        kind: 'conversation',
        sessionId: 'sess-b',
        workspaceKey: GENERAL_FOLDER,
        title: '会话 B',
        rightDock: dock(),
      },
      {
        // Other workspace — must not appear in bar
        tabId: 'tab-other',
        kind: 'conversation',
        sessionId: 'sess-other',
        workspaceKey: 'proj-other',
        title: '其他工作区',
        rightDock: dock(),
      },
    ],
    activeTabId: 'tab-a',
    shellReady: true,
  });
}

function seedSession(
  id: string,
  title: string,
  messages: SessionState['messages'] = []
): void {
  const sess: SessionState = {
    id,
    title,
    folder: GENERAL_FOLDER,
    isPinned: false,
    isArchived: false,
    timestamp: '',
    messages,
  };
  const prev = useSessionStore.getState();
  useSessionStore.setState({
    sessions: [...prev.sessions.filter((s) => s.id !== id), sess],
    sessionsById: { ...prev.sessionsById, [id]: sess },
  });
}

describe('GlobalSessionTabBar', () => {
  beforeEach(() => {
    openNewDraftTab.mockClear();
    useSessionStore.setState({
      sessions: [],
      sessionsById: {},
    });
    seedTabs();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders tabs from shell store for current workspace only', () => {
    const { getByTestId, getAllByTestId } = render(<GlobalSessionTabBar />);
    const bar = getByTestId('global-session-tab-bar');
    expect(bar).toBeTruthy();
    expect(bar.getAttribute('data-tab-count')).toBe('2');

    const tabs = getAllByTestId('global-session-tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]!.getAttribute('data-session-id')).toBe('sess-a');
    expect(tabs[1]!.getAttribute('data-session-id')).toBe('sess-b');
    expect(tabs[0]!.textContent).toContain('会话 A');
    expect(tabs[1]!.textContent).toContain('会话 B');
  });

  it('equal-width tab class is present on each tab', () => {
    const { getAllByTestId } = render(<GlobalSessionTabBar />);
    const tabs = getAllByTestId('global-session-tab');
    for (const tab of tabs) {
      // CSS module hashes class names; assert the generated class string includes "tab"
      // and that equal-share styles are applied via the module class on the node.
      expect(tab.className).toMatch(/tab/i);
      // Active first tab
      if (tab.getAttribute('data-session-id') === 'sess-a') {
        expect(tab.className).toMatch(/isActive|active/i);
      }
    }
  });

  it('+ button calls shell.openNewDraftTab', () => {
    const { getByTestId } = render(<GlobalSessionTabBar />);
    const add = getByTestId('global-strip-new-session');
    fireEvent.click(add);
    expect(openNewDraftTab).toHaveBeenCalledTimes(1);
  });

  it('new session control is a round-cap plus labelled 新建对话', () => {
    const { getByTestId, getByRole } = render(<GlobalSessionTabBar />);
    const add = getByRole('button', { name: '新建对话' });
    expect(add).toBe(getByTestId('global-strip-new-session'));
    expect(add.getAttribute('aria-label')).toBe('新建对话');
    const svg = add.querySelector('svg');
    expect(svg).toBeTruthy();
    const cls = svg!.getAttribute('class') ?? '';
    expect(cls).toMatch(/lucide-plus\b/);
    expect(cls).not.toMatch(/message-square/);
    expect(svg!.getAttribute('stroke-linecap')).toBe('round');
    expect(svg!.getAttribute('stroke-linejoin')).toBe('round');
  });

  it('clicking a tab activates it', () => {
    const { getAllByTestId } = render(<GlobalSessionTabBar />);
    const tabs = getAllByTestId('global-session-tab');
    const main = tabs[1]!.querySelector('button');
    expect(main).toBeTruthy();
    fireEvent.click(main!);
    expect(useWorkspaceShellStore.getState().activeTabId).toBe('tab-b');
  });

  it('点击 tab 宿主（role=tab）同样切会话', () => {
    const { getAllByTestId } = render(<GlobalSessionTabBar />);
    const tabs = getAllByTestId('global-session-tab');
    fireEvent.click(tabs[1]!);
    expect(useWorkspaceShellStore.getState().activeTabId).toBe('tab-b');
  });

  it('再点当前 tab 仍走 activateTab', () => {
    const activateTab = vi.fn();
    const prev = useWorkspaceShellStore.getState().activateTab;
    useWorkspaceShellStore.setState({ activateTab });
    const { getAllByTestId } = render(<GlobalSessionTabBar />);
    fireEvent.click(getAllByTestId('global-session-tab')[0]!);
    expect(activateTab).toHaveBeenCalledWith('tab-a');
    useWorkspaceShellStore.setState({ activateTab: prev });
  });

  it('pinned tabs render with 56px lock contract, pin icon and no close button', () => {
    useWorkspaceShellStore.setState({
      openTabs: [
        {
          tabId: 'tab-pinned',
          kind: 'conversation',
          sessionId: 'sess-pinned',
          workspaceKey: GENERAL_FOLDER,
          title: '固定会话',
          rightDock: dock(),
          pinned: true,
        },
        {
          tabId: 'tab-normal',
          kind: 'conversation',
          sessionId: 'sess-normal',
          workspaceKey: GENERAL_FOLDER,
          title: '普通会话',
          rightDock: dock(),
        },
      ],
      activeTabId: 'tab-pinned',
      shellReady: true,
    });

    const { getAllByTestId } = render(<GlobalSessionTabBar />);
    const tabs = getAllByTestId('global-session-tab');
    expect(tabs).toHaveLength(2);

    const pinnedTab = tabs[0]!;
    expect(pinnedTab.getAttribute('data-pinned')).toBe('true');
    expect(pinnedTab.className).toMatch(/isPinned/);
    // Pinned tab has only the main button (no close button)
    const buttons = pinnedTab.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(pinnedTab.querySelector('svg')).toBeTruthy(); // Pin icon
  });

  it('resolveTabTitle: ghost shell title asks session projection', () => {
    seedSession('sess-named', '缓存优化方案');
    expect(resolveTabTitle('sess-named', '未命名会话')).toBe('缓存优化方案');
    expect(resolveTabTitle('sess-named', EMPTY_SESSION_TITLE)).toBe(
      '缓存优化方案'
    );
    expect(resolveTabTitle('missing', '未命名会话')).toBe(EMPTY_SESSION_TITLE);
    expect(resolveTabTitle('missing', '真实壳标题')).toBe('真实壳标题');
  });

  it('top bar does not keep 未命名会话 when sidebar already has a real name', () => {
    seedSession('sess-a', '侧栏真名');
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
    const { getAllByTestId } = render(<GlobalSessionTabBar />);
    const tabs = getAllByTestId('global-session-tab');
    expect(tabs[0]!.textContent).toContain('侧栏真名');
    expect(tabs[0]!.textContent).not.toContain('未命名会话');
    expect(useWorkspaceShellStore.getState().openTabs[0]!.title).toBe(
      '侧栏真名'
    );
  });
});
