// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TreeLeafPanel } from './TreeLeafPanel';
import { useWorkspaceShellStore } from '../../store/storeAccess';
import { useLayoutTreeStore } from '../../store/layout-tree';
import { createLeaf } from '../../store/layout-tree/types';
import { registerBuiltInViews, type ViewFactoryMap } from '../../services/view-registry';
import { setPrimaryPanelChecker } from '../../store/layout-tree';
import type { ViewRenderContext } from '../../services/view-registry';

const mockButtonClick = vi.fn();
const mockInputFocus = vi.fn();
const mockMenuItemClick = vi.fn();

const gestureTestFactories: ViewFactoryMap = {
  chat: () =>
    React.lazy(async () => ({
      default: (ctx: ViewRenderContext) => (
        <div data-testid="chat-view-container" style={{ padding: '20px' }}>
          <button
            data-testid="mode-select-btn"
            onClick={mockButtonClick}
          >
            Mode Option
          </button>
          <input
            data-testid="composer-input"
            onFocus={mockInputFocus}
            placeholder="Type a message"
          />
          <div role="menu">
            <div
              role="menuitem"
              data-testid="menu-item-option"
              onClick={mockMenuItemClick}
            >
              Dropdown Option
            </div>
          </div>
          <div data-testid="empty-canvas-space">
            Empty space in pane
          </div>
        </div>
      ),
    })),
  files: () =>
    React.lazy(async () => ({
      default: () => <div data-testid="files-view">Files</div>,
    })),
  'file-viewer': () => (() => null) as unknown as React.ComponentType<ViewRenderContext>,
  terminal: () => (() => null) as unknown as React.ComponentType<ViewRenderContext>,
  preview: () => (() => null) as unknown as React.ComponentType<ViewRenderContext>,
  overview: () => (() => null) as unknown as React.ComponentType<ViewRenderContext>,
  diff: () => (() => null) as unknown as React.ComponentType<ViewRenderContext>,
  runtime: () => (() => null) as unknown as React.ComponentType<ViewRenderContext>,
  agent: () => (() => null) as unknown as React.ComponentType<ViewRenderContext>,
  browser: () => (() => null) as unknown as React.ComponentType<ViewRenderContext>,
  'flow-dag': () => (() => null) as unknown as React.ComponentType<ViewRenderContext>,
};

describe('TreeLeafPanel Gesture & Interactive Guard (Regression Test)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPrimaryPanelChecker((pid) => pid === 'chat');
    registerBuiltInViews(gestureTestFactories);
    useWorkspaceShellStore.setState({
      activeTabId: 'tab-1',
      openTabs: [
        {
          tabId: 'tab-1',
          sessionId: 'session-1',
          title: 'Session 1',
          isPinned: false,
          rightDock: { openPanelIds: [] },
        } as any,
        {
          tabId: 'tab-2',
          sessionId: 'session-2',
          title: 'Session 2',
          isPinned: false,
          rightDock: { openPanelIds: [] },
        } as any,
      ],
    });
  });

  it('断言 1：在分屏状态下点击叶子内部的按钮，按钮的 onClick 回调必定触发且不被抢跑阻断', async () => {
    const leaf = createLeaf('chat', ['chat'], 'chat', 'session-2');
    const setActiveLeafSpy = vi.spyOn(useLayoutTreeStore.getState(), 'setActiveLeaf');

    render(
      <TreeLeafPanel
        leaf={leaf}
        rect={{ x: 0.5, y: 0, width: 0.5, height: 1 }}
        isActive={false}
        isDragSource={false}
      />
    );

    const modeBtn = await screen.findByTestId('mode-select-btn');
    fireEvent.pointerDown(modeBtn);
    fireEvent.click(modeBtn);

    expect(mockButtonClick).toHaveBeenCalledTimes(1);
    // 智能守卫命中交互元素，不抢占激活
    expect(setActiveLeafSpy).not.toHaveBeenCalled();
  });

  it('断言 2：在分屏状态下点击输入框与 role="menuitem"，放行事件流', async () => {
    const leaf = createLeaf('chat', ['chat'], 'chat', 'session-2');
    const setActiveLeafSpy = vi.spyOn(useLayoutTreeStore.getState(), 'setActiveLeaf');

    render(
      <TreeLeafPanel
        leaf={leaf}
        rect={{ x: 0.5, y: 0, width: 0.5, height: 1 }}
        isActive={false}
        isDragSource={false}
      />
    );

    const inputEl = await screen.findByTestId('composer-input');
    fireEvent.pointerDown(inputEl);
    fireEvent.focus(inputEl);
    expect(mockInputFocus).toHaveBeenCalledTimes(1);
    expect(setActiveLeafSpy).not.toHaveBeenCalled();

    const menuItem = screen.getByTestId('menu-item-option');
    fireEvent.pointerDown(menuItem);
    fireEvent.click(menuItem);
    expect(mockMenuItemClick).toHaveBeenCalledTimes(1);
    expect(setActiveLeafSpy).not.toHaveBeenCalled();
  });

  it('断言 3：在分屏非交互空白区域点击时，正确激活当前 Leaf 并同步 Shell Active Session', async () => {
    const leaf1 = createLeaf('chat', ['chat'], 'chat', 'session-1');
    const leaf2 = createLeaf('chat', ['chat'], 'chat', 'session-2');
    useLayoutTreeStore.setState({
      activeLeafId: leaf1.id,
      tree: {
        root: {
          type: 'branch',
          id: 'split-root',
          direction: 'horizontal',
          splitRatio: 0.5,
          children: [leaf1, leaf2],
        },
        version: 1,
      },
    });

    render(
      <TreeLeafPanel
        leaf={leaf2}
        rect={{ x: 0.5, y: 0, width: 0.5, height: 1 }}
        isActive={false}
        isDragSource={false}
      />
    );

    const emptySpace = await screen.findByTestId('empty-canvas-space');
    fireEvent.pointerDown(emptySpace);

    expect(useLayoutTreeStore.getState().activeLeafId).toBe(leaf2.id);
    expect(useWorkspaceShellStore.getState().activeTabId).toBe('tab-2');
  });
});
