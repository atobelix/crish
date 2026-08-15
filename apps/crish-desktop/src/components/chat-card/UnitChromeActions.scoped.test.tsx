// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { UnitChromeActions } from './UnitChromeActions';
import {
  useWorkspaceShellStore,
  createDefaultDock,
} from '../../store/workspace-shell';
import { useLayoutTreeStore } from '../../store/layout-tree';
import { useLayoutStore } from '../../store/layoutStore';
import type { SessionState } from '../../store/types';
import { GENERAL_FOLDER } from '../../api/projectStore';

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
