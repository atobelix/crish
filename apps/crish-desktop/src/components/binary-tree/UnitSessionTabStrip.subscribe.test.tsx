// @vitest-environment jsdom
/**
 * D0-5 strip-subscribe-narrow — equality 契约 + rightDock 不触发 strip re-render。
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import {
  UnitSessionTabStrip,
  openTabsStripRelevantEqual,
  chatUnitsEqual,
} from './UnitSessionTabStrip';
import {
  useWorkspaceShellStore,
  createDefaultDock,
  listChatUnits,
  type TabSurface,
  type ChatUnitRef,
} from '../../store/workspace-shell';
import { useLayoutTreeStore } from '../../store/layout-tree';
import { createLeaf, createBranch } from '../../store/layout-tree/types';
import { GENERAL_FOLDER } from '../../api/projectStore';

const dock = () => createDefaultDock();

function makeTab(
  partial: Partial<TabSurface> & Pick<TabSurface, 'tabId' | 'sessionId'>
): TabSurface {
  return {
    kind: 'conversation',
    workspaceKey: GENERAL_FOLDER,
    title: partial.title ?? partial.sessionId,
    rightDock: dock(),
    ...partial,
  };
}

describe('openTabsStripRelevantEqual', () => {
  it('same reference → true', () => {
    const tabs = [makeTab({ tabId: 't1', sessionId: 's1' })];
    expect(openTabsStripRelevantEqual(tabs, tabs)).toBe(true);
  });

  it('rightDock-only change → equal (strip 不关心坞状态)', () => {
    const a = [makeTab({ tabId: 't1', sessionId: 's1', title: 'A' })];
    const b = [
      makeTab({
        tabId: 't1',
        sessionId: 's1',
        title: 'A',
        rightDock: createDefaultDock({
          collapsed: false,
          openPanelIds: ['files'],
        }),
      }),
    ];
    expect(openTabsStripRelevantEqual(a, b)).toBe(true);
  });

  it('title / sessionId / workspaceKey 变化 → not equal', () => {
    const base = makeTab({ tabId: 't1', sessionId: 's1', title: 'A' });
    expect(
      openTabsStripRelevantEqual(
        [base],
        [makeTab({ tabId: 't1', sessionId: 's1', title: 'B' })]
      )
    ).toBe(false);
    expect(
      openTabsStripRelevantEqual(
        [base],
        [makeTab({ tabId: 't1', sessionId: 's2', title: 'A' })]
      )
    ).toBe(false);
    expect(
      openTabsStripRelevantEqual(
        [base],
        [
          makeTab({
            tabId: 't1',
            sessionId: 's1',
            title: 'A',
            workspaceKey: 'proj-x',
          }),
        ]
      )
    ).toBe(false);
  });
});

describe('chatUnitsEqual', () => {
  it('leafId + sessionId 相同 → equal', () => {
    const a: ChatUnitRef[] = [
      { leafId: 'L1', sessionId: 's1' },
      { leafId: 'L2', sessionId: 's2' },
    ];
    const b: ChatUnitRef[] = [
      { leafId: 'L1', sessionId: 's1' },
      { leafId: 'L2', sessionId: 's2' },
    ];
    expect(chatUnitsEqual(a, b)).toBe(true);
  });

  it('sessionId 变化 → not equal', () => {
    expect(
      chatUnitsEqual(
        [{ leafId: 'L1', sessionId: 's1' }],
        [{ leafId: 'L1', sessionId: 's2' }]
      )
    ).toBe(false);
  });
});

describe('UnitSessionTabStrip narrow re-render', () => {
  let leafId = '';
  let shellSubRenders = 0;
  let unitsSubRenders = 0;

  /**
   * 与 UnitSessionTabStrip 同形的窄订阅探针：
   * 子组件 store 订阅不会让父 wrapper re-render，故单独探针计数。
   */
  function ShellTabsProbe() {
    useStoreWithEqualityFn(
      useWorkspaceShellStore,
      (s) => s.openTabs,
      openTabsStripRelevantEqual
    );
    shellSubRenders += 1;
    return null;
  }

  function UnitsProbe() {
    useStoreWithEqualityFn(
      useLayoutTreeStore,
      (s) => listChatUnits(s.tree.root),
      chatUnitsEqual
    );
    unitsSubRenders += 1;
    return null;
  }

  beforeEach(() => {
    shellSubRenders = 0;
    unitsSubRenders = 0;
    const leaf = createLeaf('chat', ['chat'], 'chat', 'sess-a');
    leafId = leaf.id;
    useLayoutTreeStore.setState({
      tree: { root: leaf, version: 2 },
      activeLeafId: leaf.id,
    });
    useWorkspaceShellStore.setState({
      openTabs: [
        makeTab({ tabId: 'tab-a', sessionId: 'sess-a', title: '会话 A' }),
        makeTab({ tabId: 'tab-b', sessionId: 'sess-b', title: '会话 B' }),
      ],
      activeTabId: 'tab-a',
      shellReady: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('rightDock 更新不触发 openTabs 窄订阅 re-render', () => {
    const { getAllByTestId } = render(
      <>
        <ShellTabsProbe />
        <UnitSessionTabStrip leafId={leafId} leafSessionId="sess-a" />
      </>
    );
    expect(getAllByTestId('unit-session-tab').length).toBeGreaterThanOrEqual(1);
    const afterMount = shellSubRenders;
    expect(afterMount).toBeGreaterThanOrEqual(1);

    act(() => {
      const prev = useWorkspaceShellStore.getState().openTabs;
      useWorkspaceShellStore.setState({
        openTabs: prev.map((t) =>
          t.tabId === 'tab-a'
            ? {
                ...t,
                rightDock: createDefaultDock({
                  collapsed: false,
                  openPanelIds: ['terminal'],
                  activePanelId: 'terminal',
                }),
              }
            : t
        ),
      });
    });

    expect(shellSubRenders).toBe(afterMount);
    // 标签仍在（行为未丢）
    expect(getAllByTestId('unit-session-tab').length).toBeGreaterThanOrEqual(2);
  });

  it('title 更新会 re-render 并反映新标题', () => {
    const { getAllByTestId } = render(
      <>
        <ShellTabsProbe />
        <UnitSessionTabStrip leafId={leafId} leafSessionId="sess-a" />
      </>
    );
    const afterMount = shellSubRenders;

    act(() => {
      const prev = useWorkspaceShellStore.getState().openTabs;
      useWorkspaceShellStore.setState({
        openTabs: prev.map((t) =>
          t.tabId === 'tab-a' ? { ...t, title: '改名后' } : t
        ),
      });
    });

    expect(shellSubRenders).toBeGreaterThan(afterMount);
    const labels = getAllByTestId('unit-session-tab').map(
      (el) => el.textContent ?? ''
    );
    expect(labels.some((l) => l.includes('改名后'))).toBe(true);
  });

  it('非 chat 布局扰动（tool splitRatio）不触发 units 窄订阅 re-render', () => {
    // 单 chat + tool 水平分栏：改 split 不应动 chat unit 列表
    const chat = createLeaf('chat', ['chat'], 'chat', 'sess-a');
    const tool = createLeaf('files', ['files'], 'files', 'sess-a');
    const root = createBranch('horizontal', chat, tool, 0.5);
    leafId = chat.id;
    useLayoutTreeStore.setState({
      tree: { root, version: 2 },
      activeLeafId: chat.id,
    });

    const { getAllByTestId } = render(
      <>
        <UnitsProbe />
        <UnitSessionTabStrip leafId={leafId} leafSessionId="sess-a" />
      </>
    );
    const afterMount = unitsSubRenders;
    expect(getAllByTestId('unit-session-tab').length).toBeGreaterThanOrEqual(1);

    act(() => {
      useLayoutTreeStore.getState().resizeBranch(root.id, 0.35, false);
    });

    expect(unitsSubRenders).toBe(afterMount);
  });
});
