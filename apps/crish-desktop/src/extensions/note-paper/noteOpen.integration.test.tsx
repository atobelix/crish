// @vitest-environment jsdom
/**
 * 开笔记走 tab.dock 抽屉，不再把 note 投影成树叶。
 * jsdom 绿 ≠ 打开完成 ≠ 关 EL。抽屉 DOM 归维 05。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from '@testing-library/react';
import { GENERAL_FOLDER } from '../../api/projectStore';
import { useLayoutStore } from '../../store/layoutStore';
import {
  useLayoutTreeStore,
  listChatLeaves,
  listToolLeaves,
  setPrimaryPanelChecker,
} from '../../store/layout-tree';
import { createLeaf, type LayoutLeaf } from '../../store/layout-tree/types';
import {
  createDefaultDock,
  useWorkspaceShellStore,
} from '../../store/workspace-shell';
import { viewRegistry } from '../../services/view-registry';
import type { SessionState } from '../../store/types';
import { getCompositionRoot } from '../../app/compositionRoot';
import { openToolInSession } from '../../store/storeAccess';
import {
  findTabBySessionId,
  readLeafDock,
  type LeafSessionTab,
} from '../../store/workspace-shell/openTool';
import { collectDockTabs } from '../../store/layout-tree/dockLayoutModel';
import { activateNotePaper, deactivateNotePaper } from './activate';

const SID = 'sess-note-open';
const TAB_ID = 'tab-note-open';

function seedStores(): void {
  setPrimaryPanelChecker((id: string) => viewRegistry.isPrimary(id));
  useLayoutStore.setState((st) => {
    st.sessionsById = {
      [SID]: {
        id: SID,
        title: '会话',
        folder: '默认',
        isPinned: false,
        isArchived: false,
        timestamp: '2026-08-18',
        messages: [],
        agents: [],
      } as unknown as SessionState,
    };
    st.activeSessionId = SID;
  });
  const tab: LeafSessionTab = {
    tabId: TAB_ID,
    sessionId: SID,
    title: '会话',
    workspaceKey: GENERAL_FOLDER,
    dock: createDefaultDock({ collapsed: true }),
  };
  const chatLeaf: LayoutLeaf = createLeaf({
    tabs: [tab],
    activeTabId: TAB_ID,
  });
  // 维 05 未切 UI 前 TreeLeafPanel 仍读 shell openTabs
  useWorkspaceShellStore.setState({
    openTabs: [
      {
        tabId: TAB_ID,
        kind: 'conversation',
        sessionId: SID,
        workspaceKey: GENERAL_FOLDER,
        title: '会话',
        rightDock: createDefaultDock({ collapsed: true }),
      },
    ],
    activeTabId: TAB_ID,
    shellReady: true,
  });
  useLayoutTreeStore.setState({
    tree: { root: chatLeaf, version: 2 },
    activeLeafId: chatLeaf.id,
    toolColumnCollapsed: true,
    past: [],
    future: [],
  });
}

describe('note-paper open integration（02 F8 / F9）', () => {
  beforeEach(() => {
    deactivateNotePaper();
    getCompositionRoot();
    seedStores();
    activateNotePaper();
  });

  afterEach(() => {
    act(() => {
      deactivateNotePaper();
    });
  });

  it('F8 打开笔记后 tab.dock 含 note 且解折叠，仍单 chat 叶、无 tool 叶', () => {
    act(() => {
      openToolInSession(SID, 'note');
    });

    const root = useLayoutTreeStore.getState().tree.root;
    const hit = findTabBySessionId(root, SID);
    const dock = hit?.tab.dock;
    expect(dock).toBeTruthy();
    expect(
      collectDockTabs(dock!.tree).some((tab) => tab.viewId === 'note')
    ).toBe(true);
    expect(dock!.collapsed).toBe(false);
    expect(listChatLeaves(root)).toHaveLength(1);
    expect(listToolLeaves(root)).toHaveLength(0);
  });

  it('F9 开笔记不造 note 树叶；坞在活动 tab.dock（抽屉 DOM 归维 05）', () => {
    act(() => {
      openToolInSession(SID, 'note');
    });

    const state = useLayoutTreeStore.getState();
    const chatLeaf = listChatLeaves(state.tree.root)[0];
    expect(chatLeaf).toBeTruthy();
    expect(listToolLeaves(state.tree.root)).toHaveLength(0);
    const dock = readLeafDock(chatLeaf!);
    expect(
      collectDockTabs(dock.tree).some((tab) => tab.viewId === 'note')
    ).toBe(true);
    expect(dock.collapsed).toBe(false);
    expect(chatLeaf!.id).toBe(state.activeLeafId);
  });
});
