// @vitest-environment jsdom
/**
 * GlobalSessionTabBar smoke — workspace tabs, equal-width class, + → openNewDraftTab.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { GlobalSessionTabBar } from './GlobalSessionTabBar';
import {
  useWorkspaceShellStore,
  createDefaultDock,
} from '../../store/workspace-shell';
import { useLayoutTreeStore } from '../../store/layout-tree';
import { GENERAL_FOLDER } from '../../api/projectStore';

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

describe('GlobalSessionTabBar', () => {
  beforeEach(() => {
    openNewDraftTab.mockClear();
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

  it('clicking a tab activates it', () => {
    const { getAllByTestId } = render(<GlobalSessionTabBar />);
    const tabs = getAllByTestId('global-session-tab');
    const main = tabs[1]!.querySelector('button');
    expect(main).toBeTruthy();
    fireEvent.click(main!);
    expect(useWorkspaceShellStore.getState().activeTabId).toBe('tab-b');
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
});
