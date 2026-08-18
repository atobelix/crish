// @vitest-environment jsdom
/**
 * activate + chrome 点击 → dock / 树 / 叶内 Strict。
 * jsdom 绿 ≠ 打开完成 ≠ 关 EL。
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { UnitChromeActions } from '../../components/chat-card/UnitChromeActions';
import { TreeLeafPanel } from '../../components/binary-tree/TreeLeafPanel';
import { GENERAL_FOLDER } from '../../api/projectStore';
import { useLayoutStore } from '../../store/layoutStore';
import { useLayoutTreeStore } from '../../store/layout-tree';
import { collectLeaves } from '../../store/layout-tree';
import { createLeaf } from '../../store/layout-tree/types';
import {
  createDefaultDock,
  useWorkspaceShellStore,
} from '../../store/workspace-shell';
import { viewRegistry } from '../../services/view-registry';
import type { SessionState } from '../../store/types';
import { getCompositionRoot } from '../../app/compositionRoot';
import { activateNotePaper, deactivateNotePaper } from './activate';

const SID = 'sess-note-open';

function seedStores(): void {
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
  useWorkspaceShellStore.setState({
    openTabs: [
      {
        tabId: 'tab-note-open',
        kind: 'conversation',
        sessionId: SID,
        workspaceKey: GENERAL_FOLDER,
        title: '会话',
        rightDock: createDefaultDock({ collapsed: true }),
      },
    ],
    activeTabId: 'tab-note-open',
    shellReady: true,
  });
  const chatLeaf = createLeaf('chat', ['chat'], 'chat', SID);
  useLayoutTreeStore.setState({
    tree: { root: chatLeaf, version: 1 },
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

  it('F8 点击打开笔记后 dock 含 note 且解折叠，树有非 primary note 叶', async () => {
    const { getByTestId } = render(
      <UnitChromeActions activeSessionId={SID} />
    );
    act(() => {
      getByTestId('chat-open-note').click();
    });

    const tab = useWorkspaceShellStore
      .getState()
      .openTabs.find((t) => t.sessionId === SID);
    expect(tab?.rightDock.openPanelIds).toContain('note');
    expect(tab?.rightDock.activePanelId).toBe('note');
    expect(tab?.rightDock.collapsed).toBe(false);
    expect(useLayoutTreeStore.getState().toolColumnCollapsed).toBe(false);

    const noteLeaf = collectLeaves(
      useLayoutTreeStore.getState().tree.root
    ).find(
      (l) => l.activeTab === 'note' && !viewRegistry.isPrimary(l.panelId)
    );
    expect(noteLeaf).toBeTruthy();
  });

  it('F9 工具叶 DOM 出现 note-paper-strict-panel，祖先有 data-leaf-id，无死 CTA', async () => {
    render(<UnitChromeActions activeSessionId={SID} />);
    act(() => {
      screen.getByTestId('chat-open-note').click();
    });

    const noteLeaf = collectLeaves(
      useLayoutTreeStore.getState().tree.root
    ).find((l) => l.activeTab === 'note');
    expect(noteLeaf).toBeTruthy();

    render(
      <TreeLeafPanel
        leaf={noteLeaf!}
        rect={{ x: 0.5, y: 0, width: 0.5, height: 1 }}
        isActive={true}
        isDragSource={false}
      />
    );

    const panel = await waitFor(() =>
      screen.getByTestId('note-paper-strict-panel')
    );
    expect(panel.closest('[data-leaf-id]')).toBeTruthy();
    expect(screen.queryByTestId('open-note-paper-strict')).toBeNull();
  });
});
