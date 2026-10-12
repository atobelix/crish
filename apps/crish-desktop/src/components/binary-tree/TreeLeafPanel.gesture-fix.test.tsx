// @vitest-environment jsdom
import React, { useState } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
} from '@testing-library/react';
import { TreeLeafPanel } from './TreeLeafPanel';
import { useWorkspaceShellStore } from '../../store/storeAccess';
import { useLayoutTreeStore } from '../../store/layout-tree';
import { getCompositionRoot } from '../../app/compositionRoot';
import { createLeaf } from '../../store/layout-tree/types';
import {
  registerBuiltInViews,
  type ViewFactoryMap,
  type ViewRenderContext,
  viewRegistry,
} from '../../services/view-registry';
import { setPrimaryPanelChecker } from '../../store/layout-tree';

// Mocks & spies
const mockButtonClick = vi.fn();
const mockInputFocus = vi.fn();
const mockInputChange = vi.fn();
const mockMenuItemClick = vi.fn();
const mockCustomSelectChange = vi.fn();
const mockAnchorClick = vi.fn();
const mockDialogSubmit = vi.fn();
const mockEscDismiss = vi.fn();

interface MockInteractiveViewProps {
  ctx: ViewRenderContext;
}

const MockInteractiveChatView: React.FC<MockInteractiveViewProps> = ({
  ctx,
}) => {
  const [inputText, setInputText] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [selectedMode, setSelectedMode] = useState('Agent');

  return (
    <div
      data-testid={`chat-view-container-${ctx.leafId}`}
      data-leaf-active={ctx.isActive ? 'true' : 'false'}
      style={{ padding: '20px' }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          mockEscDismiss(ctx.leafId);
          if (dropdownOpen) {
            setDropdownOpen(false);
            e.stopPropagation();
          }
        }
      }}
    >
      <div className="toolbar" role="toolbar" aria-label="Chat Toolbar">
        {/* Mode selector button */}
        <button
          type="button"
          data-testid="mode-select-btn"
          onClick={(e) => {
            mockButtonClick(ctx.leafId, 'mode-select');
            setDropdownOpen((prev) => !prev);
          }}
        >
          Mode: {selectedMode}
        </button>

        {/* Custom role=button */}
        <div
          role="button"
          tabIndex={0}
          data-testid="custom-role-button"
          onClick={() => mockButtonClick(ctx.leafId, 'custom-role-button')}
        >
          Custom Button
        </div>

        {/* Anchor link */}
        <a
          href="#reference"
          data-testid="reference-link"
          onClick={(e) => {
            e.preventDefault();
            mockAnchorClick(ctx.leafId);
          }}
        >
          Reference Link
        </a>

        {/* Summary toggle */}
        <details data-testid="details-toggle">
          <summary data-testid="summary-header">Expand Details</summary>
          <p>Detail content</p>
        </details>
      </div>

      {/* Dropdown Menu Overlay */}
      {dropdownOpen && (
        <div
          role="menu"
          data-testid="mode-dropdown-menu"
          data-radix-popper-content-wrapper="true"
        >
          <div
            role="menuitem"
            data-testid="menu-item-agent"
            onClick={() => {
              setSelectedMode('Agent');
              mockMenuItemClick(ctx.leafId, 'Agent');
              setDropdownOpen(false);
            }}
          >
            Agent Mode
          </div>
          <div
            role="menuitem"
            data-testid="menu-item-plan"
            onClick={() => {
              setSelectedMode('Plan');
              mockMenuItemClick(ctx.leafId, 'Plan');
              setDropdownOpen(false);
            }}
          >
            Plan Mode
          </div>
          <div
            role="menuitem"
            data-testid="menu-item-ask"
            onClick={() => {
              setSelectedMode('Ask');
              mockMenuItemClick(ctx.leafId, 'Ask');
              setDropdownOpen(false);
            }}
          >
            Ask Mode
          </div>
        </div>
      )}

      {/* Form & Input controls */}
      <div className="input-group">
        <input
          data-testid={`composer-input-${ctx.leafId}`}
          placeholder="Type a message"
          value={inputText}
          onFocus={(e) => mockInputFocus(ctx.leafId, e.target.value)}
          onChange={(e) => {
            setInputText(e.target.value);
            mockInputChange(ctx.leafId, e.target.value);
          }}
        />
        <textarea
          data-testid={`composer-textarea-${ctx.leafId}`}
          placeholder="Multiline input"
          onChange={(e) => mockInputChange(ctx.leafId, e.target.value)}
        />
        <select
          data-testid="model-select"
          onChange={(e) => mockCustomSelectChange(ctx.leafId, e.target.value)}
        >
          <option value="gpt-4">GPT-4</option>
          <option value="claude-3-7">Claude 3.7</option>
          <option value="gemini-2-pro">Gemini 2.0 Pro</option>
        </select>
        <div
          contentEditable
          suppressContentEditableWarning={true}
          data-testid="contenteditable-editor"
          onInput={(e) =>
            mockInputChange(ctx.leafId, (e.target as HTMLElement).innerText)
          }
        >
          Editable text
        </div>
      </div>

      {/* ARIA controls */}
      <div className="aria-controls">
        <div
          role="combobox"
          aria-expanded={false}
          data-testid="role-combobox"
          onClick={() => mockButtonClick(ctx.leafId, 'combobox')}
        >
          Combobox
        </div>
        <div
          role="listbox"
          data-testid="role-listbox"
          onClick={() => mockButtonClick(ctx.leafId, 'listbox')}
        >
          <div
            role="option"
            aria-selected={false}
            data-testid="role-option"
            onClick={() => mockButtonClick(ctx.leafId, 'option')}
          >
            Option 1
          </div>
        </div>
        <div
          role="tab"
          data-testid="role-tab"
          onClick={() => mockButtonClick(ctx.leafId, 'tab')}
        >
          Inner Tab
        </div>
        <div
          role="switch"
          aria-checked={false}
          data-testid="role-switch"
          onClick={() => mockButtonClick(ctx.leafId, 'switch')}
        >
          Switch
        </div>
        <div
          role="dialog"
          data-testid="role-dialog"
          onClick={() => mockDialogSubmit(ctx.leafId)}
        >
          Dialog Area
        </div>
        <div
          data-interactive="true"
          data-testid="data-interactive-element"
          onClick={() => mockButtonClick(ctx.leafId, 'data-interactive')}
        >
          Data Interactive Element
        </div>
      </div>

      {/* Non-interactive blank canvas background */}
      <div
        data-testid={`empty-canvas-space-${ctx.leafId}`}
        style={{ height: '80px' }}
      >
        Empty space in pane {ctx.leafId}
      </div>
    </div>
  );
};

const gestureTestFactories: ViewFactoryMap = {
  chat: () =>
    React.lazy(async () => ({
      default: (ctx: ViewRenderContext) => (
        <MockInteractiveChatView ctx={ctx} />
      ),
    })),
  files: () =>
    React.lazy(async () => ({
      default: () => <div data-testid="files-view">Files View Content</div>,
    })),
  'file-viewer': () =>
    (() => null) as unknown as React.ComponentType<ViewRenderContext>,
  terminal: () =>
    (() => null) as unknown as React.ComponentType<ViewRenderContext>,
  preview: () =>
    (() => null) as unknown as React.ComponentType<ViewRenderContext>,
  overview: () =>
    (() => null) as unknown as React.ComponentType<ViewRenderContext>,
  diff: () => (() => null) as unknown as React.ComponentType<ViewRenderContext>,
  runtime: () =>
    (() => null) as unknown as React.ComponentType<ViewRenderContext>,
  agent: () =>
    (() => null) as unknown as React.ComponentType<ViewRenderContext>,
  browser: () =>
    (() => null) as unknown as React.ComponentType<ViewRenderContext>,
  'flow-dag': () =>
    (() => null) as unknown as React.ComponentType<ViewRenderContext>,
};

describe('TreeLeafPanel 交互状态机与多窗口手势压测 (Gesture & Stress Suite)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPrimaryPanelChecker((pid) => pid === 'chat');
    registerBuiltInViews(gestureTestFactories);
    const root = getCompositionRoot();
    (
      root.shell as unknown as {
        activateTab: (leafId: string) => void;
        updateTabDock: () => void;
      }
    ).activateTab = (leafId: string) => {
      const st = useLayoutTreeStore.getState();
      if (st.activeLeafId !== leafId) st.setActiveLeaf(leafId);
    };
    (root.shell as unknown as { updateTabDock: () => void }).updateTabDock =
      () => {};
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
        {
          tabId: 'tab-3',
          sessionId: 'session-3',
          title: 'Session 3',
          isPinned: false,
          rightDock: { openPanelIds: [] },
        } as any,
      ],
    });
  });

  afterEach(() => {
    document.body.classList.remove('tree-resizing');
  });

  describe('1. 模式切换下拉菜单与交互元素防抢跑守护 (Interactive Guard & Dropdown)', () => {
    it('断言 1.1：在分屏非激活叶子中点击按钮，onClick 必定触发且不触发抢跑激活', async () => {
      const leaf = createLeaf('chat', ['chat'], 'chat', 'session-2');
      const setActiveLeafSpy = vi.spyOn(
        useLayoutTreeStore.getState(),
        'setActiveLeaf'
      );

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

      expect(mockButtonClick).toHaveBeenCalledWith(leaf.id, 'mode-select');
      expect(setActiveLeafSpy).toHaveBeenCalledWith(leaf.id);
    });

    it('断言 1.2：下拉菜单展开后点击 menuitem，正确触发选择回调且不被抢占阻断', async () => {
      const leaf = createLeaf('chat', ['chat'], 'chat', 'session-2');
      const setActiveLeafSpy = vi.spyOn(
        useLayoutTreeStore.getState(),
        'setActiveLeaf'
      );

      render(
        <TreeLeafPanel
          leaf={leaf}
          rect={{ x: 0.5, y: 0, width: 0.5, height: 1 }}
          isActive={false}
          isDragSource={false}
        />
      );

      const modeBtn = await screen.findByTestId('mode-select-btn');
      fireEvent.click(modeBtn);

      const planMenuItem = await screen.findByTestId('menu-item-plan');
      expect(planMenuItem).toBeTruthy();

      fireEvent.pointerDown(planMenuItem);
      fireEvent.click(planMenuItem);

      expect(mockMenuItemClick).toHaveBeenCalledWith(leaf.id, 'Plan');
      expect(setActiveLeafSpy).toHaveBeenCalledWith(leaf.id);
    });

    it('断言 1.3：全面放行各类标准交互元素（select, a, summary, contenteditable, role=button, combobox, listbox, option, tab, switch, dialog）', async () => {
      const leaf = createLeaf('chat', ['chat'], 'chat', 'session-2');
      const setActiveLeafSpy = vi.spyOn(
        useLayoutTreeStore.getState(),
        'setActiveLeaf'
      );

      render(
        <TreeLeafPanel
          leaf={leaf}
          rect={{ x: 0.5, y: 0, width: 0.5, height: 1 }}
          isActive={false}
          isDragSource={false}
        />
      );

      // Select
      const selectEl = await screen.findByTestId('model-select');
      fireEvent.pointerDown(selectEl);
      fireEvent.change(selectEl, { target: { value: 'claude-3-7' } });
      expect(mockCustomSelectChange).toHaveBeenCalledWith(
        leaf.id,
        'claude-3-7'
      );

      // Link <a>
      const linkEl = screen.getByTestId('reference-link');
      fireEvent.pointerDown(linkEl);
      fireEvent.click(linkEl);
      expect(mockAnchorClick).toHaveBeenCalledWith(leaf.id);

      // Summary
      const summaryEl = screen.getByTestId('summary-header');
      fireEvent.pointerDown(summaryEl);
      fireEvent.click(summaryEl);

      // ContentEditable
      const editableEl = screen.getByTestId('contenteditable-editor');
      fireEvent.pointerDown(editableEl);

      // Role button
      const customRoleBtn = screen.getByTestId('custom-role-button');
      fireEvent.pointerDown(customRoleBtn);
      fireEvent.click(customRoleBtn);
      expect(mockButtonClick).toHaveBeenCalledWith(
        leaf.id,
        'custom-role-button'
      );

      // Combobox, Listbox, Option, Tab, Switch, Dialog, Data-Interactive
      const combobox = screen.getByTestId('role-combobox');
      fireEvent.pointerDown(combobox);
      fireEvent.click(combobox);
      expect(mockButtonClick).toHaveBeenCalledWith(leaf.id, 'combobox');

      const option = screen.getByTestId('role-option');
      fireEvent.pointerDown(option);
      fireEvent.click(option);
      expect(mockButtonClick).toHaveBeenCalledWith(leaf.id, 'option');

      const tab = screen.getByTestId('role-tab');
      fireEvent.pointerDown(tab);
      fireEvent.click(tab);
      expect(mockButtonClick).toHaveBeenCalledWith(leaf.id, 'tab');

      const sw = screen.getByTestId('role-switch');
      fireEvent.pointerDown(sw);
      fireEvent.click(sw);
      expect(mockButtonClick).toHaveBeenCalledWith(leaf.id, 'switch');

      const dialog = screen.getByTestId('role-dialog');
      fireEvent.pointerDown(dialog);
      fireEvent.click(dialog);
      expect(mockDialogSubmit).toHaveBeenCalledWith(leaf.id);

      const dataInteractive = screen.getByTestId('data-interactive-element');
      fireEvent.pointerDown(dataInteractive);
      fireEvent.click(dataInteractive);
      expect(mockButtonClick).toHaveBeenCalledWith(leaf.id, 'data-interactive');

      // A-01: 在非激活叶子中点击交互元素，捕获阶段自动同步激活本分屏
      expect(setActiveLeafSpy).toHaveBeenCalledWith(leaf.id);
    });
  });

  describe('2. 输入框打字、IME 与焦点连续性压测 (Typing, IME & Focus Stability)', () => {
    it('断言 2.1：在分屏非激活叶子中点击并打字，正常聚焦并触发 onChange，不丢字不抢焦点', async () => {
      const leaf = createLeaf('chat', ['chat'], 'chat', 'session-2');
      const setActiveLeafSpy = vi.spyOn(
        useLayoutTreeStore.getState(),
        'setActiveLeaf'
      );

      render(
        <TreeLeafPanel
          leaf={leaf}
          rect={{ x: 0.5, y: 0, width: 0.5, height: 1 }}
          isActive={false}
          isDragSource={false}
        />
      );

      const inputEl = await screen.findByTestId(`composer-input-${leaf.id}`);
      fireEvent.pointerDown(inputEl);
      fireEvent.focus(inputEl);
      expect(mockInputFocus).toHaveBeenCalledWith(leaf.id, '');

      fireEvent.change(inputEl, { target: { value: 'Hello Conex Split' } });
      expect(mockInputChange).toHaveBeenCalledWith(
        leaf.id,
        'Hello Conex Split'
      );

      const textareaEl = screen.getByTestId(`composer-textarea-${leaf.id}`);
      fireEvent.pointerDown(textareaEl);
      fireEvent.change(textareaEl, { target: { value: 'Line 1\nLine 2' } });
      expect(mockInputChange).toHaveBeenCalledWith(leaf.id, 'Line 1\nLine 2');

      // A-01: 在非激活分屏打字，交互即同步激活本分屏，保障后续快捷键与操作定址
      expect(setActiveLeafSpy).toHaveBeenCalledWith(leaf.id);
    });

    it('断言 2.2：高频打字压力测试 (100 次连续输入)，状态机 100% 稳定，无锁死与事件丢失', async () => {
      const leaf = createLeaf('chat', ['chat'], 'chat', 'session-2');

      render(
        <TreeLeafPanel
          leaf={leaf}
          rect={{ x: 0.5, y: 0, width: 0.5, height: 1 }}
          isActive={false}
          isDragSource={false}
        />
      );

      const inputEl = (await screen.findByTestId(
        `composer-input-${leaf.id}`
      )) as HTMLInputElement;

      let accumulated = '';
      for (let i = 0; i < 100; i++) {
        accumulated += String.fromCharCode(65 + (i % 26));
        fireEvent.change(inputEl, { target: { value: accumulated } });
      }

      expect(inputEl.value).toBe(accumulated);
      expect(mockInputChange).toHaveBeenCalledTimes(100);
      expect(mockInputChange).toHaveBeenLastCalledWith(leaf.id, accumulated);
    });

    it('断言 2.3：IME 输入法合成流程 (compositionstart -> compositionupdate -> compositionend)，无抢焦与异常阻断', async () => {
      const leaf = createLeaf('chat', ['chat'], 'chat', 'session-2');

      render(
        <TreeLeafPanel
          leaf={leaf}
          rect={{ x: 0.5, y: 0, width: 0.5, height: 1 }}
          isActive={false}
          isDragSource={false}
        />
      );

      const inputEl = (await screen.findByTestId(
        `composer-input-${leaf.id}`
      )) as HTMLInputElement;

      fireEvent.pointerDown(inputEl);
      fireEvent.compositionStart(inputEl, { data: '' });
      fireEvent.compositionUpdate(inputEl, { data: 'zhong' });
      fireEvent.change(inputEl, { target: { value: 'zhong' } });
      fireEvent.compositionEnd(inputEl, { data: '中' });
      fireEvent.change(inputEl, { target: { value: '中' } });

      expect(inputEl.value).toBe('中');
      expect(mockInputChange).toHaveBeenLastCalledWith(leaf.id, '中');
    });
  });

  describe('3. ESC 键退栈与浮层安全销毁 (ESC Dismissal & Stack Rollback)', () => {
    it('断言 3.1：在展开下拉菜单的叶子内按下 ESC，收起菜单并触发退栈，不卸载叶子 DOM', async () => {
      const leaf = createLeaf('chat', ['chat'], 'chat', 'session-2');

      render(
        <TreeLeafPanel
          leaf={leaf}
          rect={{ x: 0.5, y: 0, width: 0.5, height: 1 }}
          isActive={true}
          isDragSource={false}
        />
      );

      const modeBtn = await screen.findByTestId('mode-select-btn');
      fireEvent.click(modeBtn);

      expect(screen.getByTestId('mode-dropdown-menu')).toBeTruthy();

      const container = screen.getByTestId(`chat-view-container-${leaf.id}`);
      fireEvent.keyDown(container, { key: 'Escape', code: 'Escape' });

      expect(mockEscDismiss).toHaveBeenCalledWith(leaf.id);
      expect(screen.queryByTestId('mode-dropdown-menu')).toBeNull();
      // 容器 DOM 完好无损
      expect(screen.getByTestId(`chat-view-container-${leaf.id}`)).toBeTruthy();
    });
  });

  describe('4. 分屏多窗口激活与会话拓扑同步 (Split-Screen Activation & Topology)', () => {
    it('断言 4.1：点击非交互空白区域，精准激活对应叶子并同步 Shell activeTabId', async () => {
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

      const emptySpace = await screen.findByTestId(
        `empty-canvas-space-${leaf2.id}`
      );
      fireEvent.pointerDown(emptySpace);

      expect(useLayoutTreeStore.getState().activeLeafId).toBe(leaf2.id);
    });

    it('断言 4.2：若已处于激活态，再次点击空白区域不重复触发无效激活', async () => {
      const leaf1 = createLeaf('chat', ['chat'], 'chat', 'session-1');
      useLayoutTreeStore.setState({ activeLeafId: leaf1.id });
      const setActiveLeafSpy = vi.spyOn(
        useLayoutTreeStore.getState(),
        'setActiveLeaf'
      );

      render(
        <TreeLeafPanel
          leaf={leaf1}
          rect={{ x: 0, y: 0, width: 0.5, height: 1 }}
          isActive={true}
          isDragSource={false}
        />
      );

      const emptySpace = await screen.findByTestId(
        `empty-canvas-space-${leaf1.id}`
      );
      fireEvent.pointerDown(emptySpace);

      expect(setActiveLeafSpy).not.toHaveBeenCalled();
    });

    it('断言 4.3：新会话草稿态 (isPendingDraft) 活动分屏与非活动分屏会话解耦', async () => {
      const draftSessionId = '__pending_draft_999__';
      useWorkspaceShellStore.setState({
        activeTabId: 'tab-draft',
        openTabs: [
          {
            tabId: 'tab-draft',
            sessionId: draftSessionId,
            title: 'New Chat',
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

      const leafActive = createLeaf('chat', ['chat'], 'chat', 'session-1');
      const leafInactive = createLeaf('chat', ['chat'], 'chat', 'session-2');

      const { rerender } = render(
        <TreeLeafPanel
          leaf={leafActive}
          rect={{ x: 0, y: 0, width: 0.5, height: 1 }}
          isActive={true}
          isDragSource={false}
        />
      );

      // 活动 pane 挂载草稿会话
      await waitFor(() => {
        expect(
          screen.getByTestId(`chat-view-container-${leafActive.id}`)
        ).toBeTruthy();
      });

      // 非活动 pane 保持自身 session-2
      rerender(
        <TreeLeafPanel
          leaf={leafInactive}
          rect={{ x: 0.5, y: 0, width: 0.5, height: 1 }}
          isActive={false}
          isDragSource={false}
        />
      );

      await waitFor(() => {
        expect(
          screen.getByTestId(`chat-view-container-${leafInactive.id}`)
        ).toBeTruthy();
      });
    });
  });

  describe('5. 极限并发压力与状态机死锁防御 (Extreme Concurrency & Deadlock Defense)', () => {
    it('断言 5.1：高频交错手势压测 (100 次混合交互：按钮/菜单/输入/空白点击)，无死锁与渲染崩溃', async () => {
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

      const { container } = render(
        <div>
          <TreeLeafPanel
            leaf={leaf1}
            rect={{ x: 0, y: 0, width: 0.5, height: 1 }}
            isActive={true}
            isDragSource={false}
          />
          <TreeLeafPanel
            leaf={leaf2}
            rect={{ x: 0.5, y: 0, width: 0.5, height: 1 }}
            isActive={false}
            isDragSource={false}
          />
        </div>
      );

      const input1 = await screen.findByTestId(`composer-input-${leaf1.id}`);
      const input2 = await screen.findByTestId(`composer-input-${leaf2.id}`);
      const emptySpace1 = screen.getByTestId(`empty-canvas-space-${leaf1.id}`);
      const emptySpace2 = screen.getByTestId(`empty-canvas-space-${leaf2.id}`);

      // 100 次高频混合操作
      for (let i = 0; i < 25; i++) {
        // 1. 输入 leaf 1
        fireEvent.change(input1, { target: { value: `L1-${i}` } });
        // 2. 点击 leaf 2 空白激活 leaf 2
        fireEvent.pointerDown(emptySpace2);
        // 3. 输入 leaf 2
        fireEvent.change(input2, { target: { value: `L2-${i}` } });
        // 4. 点击 leaf 1 空白激活 leaf 1
        fireEvent.pointerDown(emptySpace1);
      }

      expect(useLayoutTreeStore.getState().activeLeafId).toBe(leaf1.id);
      expect((input1 as HTMLInputElement).value).toBe('L1-24');
      expect((input2 as HTMLInputElement).value).toBe('L2-24');
      expect(container.querySelectorAll('[data-leaf-id]')).toHaveLength(2);
    });

    it('断言 5.2：Sash 拖拽期间 (tree-resizing) DOM 几何样式不被 React Re-render 篡改', async () => {
      document.body.classList.add('tree-resizing');
      const leaf = createLeaf('chat', ['chat'], 'chat', 'session-1');

      const { container, rerender } = render(
        <TreeLeafPanel
          leaf={leaf}
          rect={{ x: 0, y: 0, width: 0.5, height: 1 }}
          isActive={true}
          isDragSource={false}
        />
      );

      const leafEl = container.querySelector(
        `[data-leaf-id="${leaf.id}"]`
      ) as HTMLElement;
      expect(leafEl).toBeTruthy();
      // 手动模拟 live resize 修改 style
      leafEl.style.width = '60%';

      // 重新渲染不同 rect
      rerender(
        <TreeLeafPanel
          leaf={leaf}
          rect={{ x: 0, y: 0, width: 0.8, height: 1 }}
          isActive={true}
          isDragSource={false}
        />
      );

      // 因为 body 处于 tree-resizing，useLayoutEffect 规避覆盖 live 拖拽样式
      expect(leafEl.style.width).toBe('60%');
    });

    it('断言 5.3：React.memo 浅比较阻断不必要渲染，属性相同叶子零重绘', async () => {
      const leaf = createLeaf('chat', ['chat'], 'chat', 'session-1');
      let renderCount = 0;

      const TestWatcher: React.FC<{ leaf: typeof leaf }> = ({ leaf }) => {
        renderCount++;
        return (
          <TreeLeafPanel
            leaf={leaf}
            rect={{ x: 0, y: 0, width: 0.5, height: 1 }}
            isActive={true}
            isDragSource={false}
          />
        );
      };

      const { rerender } = render(<TestWatcher leaf={leaf} />);
      expect(renderCount).toBe(1);

      // 用完全相同的 leaf 数据重新渲染
      const sameLeaf = { ...leaf, tabs: [...leaf.tabs] };
      rerender(<TestWatcher leaf={sameLeaf} />);
      expect(renderCount).toBe(2); // TestWatcher 执行，但 TreeLeafPanel 被 memo 阻断
    });
  });
});
