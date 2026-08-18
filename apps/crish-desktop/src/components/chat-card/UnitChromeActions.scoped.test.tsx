// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { UnitChromeActions } from './UnitChromeActions';
import {
  useWorkspaceShellStore,
  createDefaultDock,
} from '../../store/workspace-shell';
import { useLayoutTreeStore } from '../../store/layout-tree';
import { useLayoutStore } from '../../store/layoutStore';
import type { SessionState } from '../../store/types';
import { GENERAL_FOLDER } from '../../api/projectStore';
import * as storeAccess from '../../store/storeAccess';
import {
  activateNotePaper,
  deactivateNotePaper,
} from '../../extensions/note-paper';

describe('UnitChromeActions 分屏折叠作用域单源化 (Task 2)', () => {
  beforeEach(() => {
    useLayoutStore.setState((st) => {
      st.sessionsById = {
        'unit-a': {
          id: 'unit-a',
          title: '会话 A',
          folder: '默认',
          isPinned: false,
          isArchived: false,
          timestamp: '2026-08-15',
          messages: [],
          agents: [],
        } as unknown as SessionState,
        'unit-b': {
          id: 'unit-b',
          title: '会话 B',
          folder: '默认',
          isPinned: false,
          isArchived: false,
          timestamp: '2026-08-15',
          messages: [],
          agents: [],
        } as unknown as SessionState,
      };
      st.activeSessionId = 'unit-b';
    });

    useWorkspaceShellStore.setState({
      openTabs: [
        {
          tabId: 'tab-a',
          kind: 'conversation',
          sessionId: 'unit-a',
          workspaceKey: GENERAL_FOLDER,
          title: '会话 A',
          rightDock: createDefaultDock({
            collapsed: false,
            openPanelIds: ['files'],
            activePanelId: 'files',
          }),
        },
        {
          tabId: 'tab-b',
          kind: 'conversation',
          sessionId: 'unit-b',
          workspaceKey: GENERAL_FOLDER,
          title: '会话 B',
          rightDock: createDefaultDock({
            collapsed: true,
            openPanelIds: ['overview'],
            activePanelId: null,
          }),
        },
      ],
      activeTabId: 'tab-b',
    });

    // 全局 LayoutTreeStore.toolColumnCollapsed 设为 false (因为 unit-a 展开了)
    useLayoutTreeStore.setState({
      toolColumnCollapsed: false,
    });
  });

  it('当多 Unit 分屏时，Unit B 折叠右坞后其展开按钮必须可见（不受 Unit A 展开导致的全局 false 影响）', () => {
    const { getByTestId } = render(
      <UnitChromeActions activeSessionId="unit-b" />
    );

    const expandBtn = getByTestId('right-dock-toggle');
    expect(expandBtn).toBeDefined();
  });
});

describe('UnitChromeActions 笔记闸（02 F6 / F7）', () => {
  afterEach(() => {
    act(() => {
      deactivateNotePaper();
    });
    vi.restoreAllMocks();
  });

  it('未 activate 不渲染 chat-open-note；activate 后出现，deactivate 后消失', async () => {
    deactivateNotePaper();
    const { queryByTestId, getByTestId } = render(
      <UnitChromeActions activeSessionId="unit-a" />
    );
    expect(queryByTestId('chat-open-note')).toBeNull();

    act(() => {
      activateNotePaper();
    });
    await waitFor(() => {
      expect(getByTestId('chat-open-note')).toBeTruthy();
    });

    act(() => {
      deactivateNotePaper();
    });
    await waitFor(() => {
      expect(queryByTestId('chat-open-note')).toBeNull();
    });
  });

  it('F7 点击 chat-open-note 只走 openToolInSession(sid, note)', async () => {
    act(() => {
      activateNotePaper();
    });
    const spy = vi
      .spyOn(storeAccess, 'openToolInSession')
      .mockImplementation(() => {});
    const { getByTestId } = render(
      <UnitChromeActions activeSessionId="unit-a" />
    );
    await waitFor(() => {
      expect(getByTestId('chat-open-note')).toBeTruthy();
    });
    act(() => {
      getByTestId('chat-open-note').click();
    });
    expect(spy).toHaveBeenCalledWith('unit-a', 'note');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
