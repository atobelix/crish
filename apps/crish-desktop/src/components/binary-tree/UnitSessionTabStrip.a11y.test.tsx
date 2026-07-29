// @vitest-environment jsdom
/**
 * UnitSessionTabStrip S4.5 — roving tabindex + keyboard + overflow helpers.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import {
  UnitSessionTabStrip,
  readStripOverflow,
} from './UnitSessionTabStrip';
import {
  useWorkspaceShellStore,
  createDefaultDock,
} from '../../store/workspace-shell';
import { useLayoutTreeStore } from '../../store/layout-tree';
import { createLeaf } from '../../store/layout-tree/types';
import { GENERAL_FOLDER } from '../../api/projectStore';

const dock = () => createDefaultDock();

function seedTwoTabs(active: 'tab-a' | 'tab-b' = 'tab-a') {
  const leaf = createLeaf('chat', ['chat'], 'chat', 'sess-a');
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
    activeTabId: active,
    shellReady: true,
  });
  return leaf.id;
}

describe('UnitSessionTabStrip S4.5 a11y', () => {
  let leafId = '';

  beforeEach(() => {
    leafId = seedTwoTabs('tab-a');
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('roving tabindex：仅活动/roving tab 为 0，其余 -1', () => {
    const { getAllByTestId } = render(
      <UnitSessionTabStrip leafId={leafId} leafSessionId="sess-a" />
    );
    const tabs = getAllByTestId('unit-session-tab');
    expect(tabs).toHaveLength(2);
    // active sess-a is first tab → tabIndex 0
    expect(tabs[0]!.getAttribute('tabindex')).toBe('0');
    expect(tabs[1]!.getAttribute('tabindex')).toBe('-1');
    // nested interactive elements stay out of tab order
    for (const tab of tabs) {
      const buttons = tab.querySelectorAll('button');
      expect(buttons.length).toBeGreaterThanOrEqual(1);
      for (const btn of buttons) {
        expect(btn.getAttribute('tabindex')).toBe('-1');
      }
    }
  });

  it('ArrowRight 移动 roving 焦点并 activate 下一 tab', () => {
    const { getAllByTestId } = render(
      <UnitSessionTabStrip leafId={leafId} leafSessionId="sess-a" />
    );
    const tabs = getAllByTestId('unit-session-tab');
    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' });

    // 第二 tab 成为 roving stop
    const after = getAllByTestId('unit-session-tab');
    expect(after[1]!.getAttribute('tabindex')).toBe('0');
    expect(after[0]!.getAttribute('tabindex')).toBe('-1');
    expect(useWorkspaceShellStore.getState().activeTabId).toBe('tab-b');
  });

  it('Home / End 跳到首尾 tab', () => {
    const { getAllByTestId } = render(
      <UnitSessionTabStrip leafId={leafId} leafSessionId="sess-a" />
    );
    const tabs = getAllByTestId('unit-session-tab');
    fireEvent.keyDown(tabs[0]!, { key: 'End' });
    expect(getAllByTestId('unit-session-tab')[1]!.getAttribute('tabindex')).toBe(
      '0'
    );
    fireEvent.keyDown(getAllByTestId('unit-session-tab')[1]!, { key: 'Home' });
    expect(getAllByTestId('unit-session-tab')[0]!.getAttribute('tabindex')).toBe(
      '0'
    );
  });

  it('readStripOverflow：无溢出双 false；有滚动边正确', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollWidth', { value: 100, configurable: true });
    Object.defineProperty(el, 'clientWidth', { value: 100, configurable: true });
    Object.defineProperty(el, 'scrollLeft', {
      value: 0,
      writable: true,
      configurable: true,
    });
    expect(readStripOverflow(el)).toEqual({ start: false, end: false });

    Object.defineProperty(el, 'scrollWidth', { value: 300, configurable: true });
    Object.defineProperty(el, 'clientWidth', { value: 100, configurable: true });
    el.scrollLeft = 0;
    expect(readStripOverflow(el)).toEqual({ start: false, end: true });

    el.scrollLeft = 200;
    expect(readStripOverflow(el)).toEqual({ start: true, end: false });

    el.scrollLeft = 80;
    expect(readStripOverflow(el)).toEqual({ start: true, end: true });
  });
});
