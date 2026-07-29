// @vitest-environment jsdom
/**
 * UnitSessionTabStrip D5 拖拽接线 — 属性与 startSessionDrag 入口。
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { UnitSessionTabStrip } from './UnitSessionTabStrip';
import {
  useWorkspaceShellStore,
  createDefaultDock,
} from '../../store/workspace-shell';
import { useLayoutTreeStore } from '../../store/layout-tree';
import { createLeaf } from '../../store/layout-tree/types';
import { GENERAL_FOLDER } from '../../api/projectStore';

const dock = () => createDefaultDock();

describe('UnitSessionTabStrip D5 drag wiring', () => {
  let leafId = '';

  beforeEach(() => {
    const leaf = createLeaf('chat', ['chat'], 'chat', 'sess-a');
    leafId = leaf.id;
    useLayoutTreeStore.setState({
      tree: { root: leaf, version: 2 },
      activeLeafId: leaf.id,
    });
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
      ],
      activeTabId: 'tab-a',
      shellReady: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('tab 带 data-topbar-session-id 供 useTopBarDrag 命中', () => {
    const { getAllByTestId } = render(
      <UnitSessionTabStrip leafId={leafId} leafSessionId="sess-a" />
    );
    const tabs = getAllByTestId('unit-session-tab');
    expect(tabs.length).toBeGreaterThanOrEqual(1);
    for (const tab of tabs) {
      const sid = tab.getAttribute('data-session-id');
      expect(tab.getAttribute('data-topbar-session-id')).toBe(sid);
    }
  });

  it('pointerdown 调用 startSessionDrag(sessionId, title, event)', () => {
    const startSessionDrag = vi.fn();
    const { getAllByTestId } = render(
      <UnitSessionTabStrip
        leafId={leafId}
        leafSessionId="sess-a"
        startSessionDrag={startSessionDrag}
      />
    );
    const tab = getAllByTestId('unit-session-tab')[0];
    fireEvent.pointerDown(tab, { button: 0, clientX: 10, clientY: 10 });
    expect(startSessionDrag).toHaveBeenCalledTimes(1);
    const [sessionId, title, ev] = startSessionDrag.mock.calls[0];
    expect(sessionId).toBe(tab.getAttribute('data-session-id'));
    expect(typeof title).toBe('string');
    expect(ev).toBeTruthy();
  });

  it('关闭按钮 pointerdown 不冒泡启动拖拽', () => {
    const startSessionDrag = vi.fn();
    const { getAllByTestId, container } = render(
      <UnitSessionTabStrip
        leafId={leafId}
        leafSessionId="sess-a"
        startSessionDrag={startSessionDrag}
      />
    );
    const close = container.querySelector(
      '[aria-label^="关闭会话标签"]'
    ) as HTMLElement | null;
    expect(close).toBeTruthy();
    fireEvent.pointerDown(close!, { button: 0 });
    expect(startSessionDrag).not.toHaveBeenCalled();
    fireEvent.pointerDown(getAllByTestId('unit-session-tab')[0], {
      button: 0,
    });
    expect(startSessionDrag).toHaveBeenCalledTimes(1);
  });
});
