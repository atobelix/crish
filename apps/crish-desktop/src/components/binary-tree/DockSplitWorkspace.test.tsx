// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { DockSplitWorkspace } from './DockSplitWorkspace';
import type { RightToolDockState } from '../../store/layout-tree/sessionTabModel';
import {
  createDefaultDockTree,
  createToolTab,
  openToolInDock,
  splitDockLeaf,
  type DockLeaf,
  type DockTree,
} from '../../store/layout-tree/dockLayoutModel';
import * as storeAccess from '../../store/storeAccess';
import * as treeLeafModel from './treeLeafPanelModel';

// Mock DockPane 供精确断言透传的 Props 与回调触发
const capturedDockPaneProps: any[] = [];
vi.mock('./DockPane', () => ({
  DockPane: (props: any) => {
    capturedDockPaneProps.push(props);
    return (
      <div
        data-testid={`dock-pane-${props.leafId}`}
        data-leaf-id={props.leafId}
        data-is-solo={props.isSolo ? 'true' : 'false'}
        data-is-maximized={props.isMaximized ? 'true' : 'false'}
        data-is-only-pane={props.isOnlyPane ? 'true' : 'false'}
      >
        <button
          data-testid={`btn-select-tab-${props.leafId}`}
          onClick={() => props.onSelectTab('dtab_test_1')}
        >
          SelectTab
        </button>
        <button
          data-testid={`btn-close-tab-${props.leafId}`}
          onClick={() =>
            props.onCloseTab(props.flatLeaf.tabs[0]?.tabId ?? 'dtab_test_1')
          }
        >
          CloseTab
        </button>
        <button
          data-testid={`btn-add-tab-${props.leafId}`}
          onClick={() => props.onAddTab?.('preview')}
        >
          AddTab
        </button>
        <button
          data-testid={`btn-split-right-${props.leafId}`}
          onClick={() => props.onSplitRight?.()}
        >
          SplitRight
        </button>
        <button
          data-testid={`btn-split-down-${props.leafId}`}
          onClick={() => props.onSplitDown?.()}
        >
          SplitDown
        </button>
        <button
          data-testid={`btn-toggle-solo-${props.leafId}`}
          onClick={() => props.onToggleSolo?.()}
        >
          ToggleSolo
        </button>
        <button
          data-testid={`btn-toggle-maximize-${props.leafId}`}
          onClick={() => props.onToggleMaximize?.()}
        >
          ToggleMaximize
        </button>
        <button
          data-testid={`btn-close-pane-${props.leafId}`}
          onClick={() => props.onClosePane?.()}
        >
          ClosePane
        </button>
        <button
          data-testid={`btn-focus-pane-${props.leafId}`}
          onClick={() => props.onFocusPane?.()}
        >
          FocusPane
        </button>
      </div>
    );
  },
}));

// Mock DockResizeSash 供断言分割线参数与拖拽提交
const capturedSashProps: any[] = [];
vi.mock('./DockResizeSash', () => ({
  DockResizeSash: (props: any) => {
    capturedSashProps.push(props);
    return (
      <div
        data-testid={`dock-sash-${props.branch.branchId}`}
        data-branch-id={props.branch.branchId}
        data-direction={props.branch.direction}
        data-split-ratio={props.branch.splitRatio}
      >
        <button
          data-testid={`btn-commit-ratio-${props.branch.branchId}`}
          onClick={() => props.onCommitRatio(props.branch.branchId, 0.65)}
        >
          CommitRatio
        </button>
      </div>
    );
  },
}));

// Mock 外部进程销毁函数与 Store Access
vi.mock('./treeLeafPanelModel', () => ({
  killDockTerminalPty: vi.fn(),
}));

vi.mock('../../store/storeAccess', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    updateLeafDock: vi.fn(),
  };
});

describe('DockSplitWorkspace 坞内分屏总调度容器架构测试 (Phase 2)', () => {
  beforeEach(() => {
    capturedDockPaneProps.length = 0;
    capturedSashProps.length = 0;
    vi.clearAllMocks();
  });

  const createSingleTabTree = (
    viewId = 'terminal',
    tabId = 'dtab_term_1'
  ): DockTree => {
    const leaf: DockLeaf = {
      type: 'leaf',
      id: 'dleaf_1',
      tabs: [createToolTab(viewId, { tabId, title: '终端 1' })],
      activeTabId: tabId,
    };
    return {
      root: leaf,
      activeDockLeafId: 'dleaf_1',
      version: 2,
    };
  };

  const createSplitTree = (
    direction: 'horizontal' | 'vertical' = 'horizontal'
  ): DockTree => {
    const baseTree = createSingleTabTree('terminal', 'dtab_term_1');
    const newTab = createToolTab('preview', {
      tabId: 'dtab_prev_2',
      title: '预览 2',
    });
    return splitDockLeaf(baseTree, 'dleaf_1', direction, newTab, 0.5);
  };

  describe('1. 空态与快速磁贴启动器', () => {
    it('当 tree 为默认空树时渲染空态，且不渲染任何 DockPane 与 Sash', () => {
      const emptyDock: RightToolDockState = {
        collapsed: false,
        widthRatio: 0.5,
        tree: createDefaultDockTree(),
      };

      const { container } = render(
        <DockSplitWorkspace
          leafId="leaf_main"
          sessionId="session_1"
          dock={emptyDock}
          isMaximized={false}
          onToggleMaximize={vi.fn()}
        />
      );

      const workspaceEl = container.querySelector(
        '[data-dock-split-workspace="true"]'
      );
      expect(workspaceEl).toBeInTheDocument();
      expect(workspaceEl?.getAttribute('data-empty')).toBe('true');
      expect(screen.getByText('暂无打开的工具窗格')).toBeInTheDocument();
      expect(screen.queryByTestId(/dock-pane-/)).toBeNull();
      expect(screen.queryByTestId(/dock-sash-/)).toBeNull();
    });

    it('点击空态中的快捷按钮（如终端）调用 onUpdateDock 创建新标签', () => {
      const onUpdateDock = vi.fn();
      const emptyDock: RightToolDockState = {
        collapsed: false,
        widthRatio: 0.5,
        tree: createDefaultDockTree(),
      };

      render(
        <DockSplitWorkspace
          leafId="leaf_main"
          sessionId="session_1"
          dock={emptyDock}
          isMaximized={false}
          onToggleMaximize={vi.fn()}
          onUpdateDock={onUpdateDock}
        />
      );

      const termBtn = screen.getByRole('button', { name: /终端/ });
      fireEvent.click(termBtn);

      expect(onUpdateDock).toHaveBeenCalledTimes(1);
      const patch = onUpdateDock.mock.calls[0][0];
      expect(patch.collapsed).toBe(false);
      expect(patch.tree).toBeDefined();
      expect(patch.tree.root.type).toBe('leaf');
      expect(patch.tree.root.tabs[0].viewId).toBe('terminal');
    });
  });

  describe('2. 单窗格渲染与基础 Props', () => {
    it('渲染单个 DockPane，锁定 isOnlyPane=true, isSolo=false，无 Sash', () => {
      const dock: RightToolDockState = {
        collapsed: false,
        widthRatio: 0.5,
        tree: createSingleTabTree(),
      };

      render(
        <DockSplitWorkspace
          leafId="leaf_main"
          sessionId="session_1"
          dock={dock}
          isMaximized={false}
          onToggleMaximize={vi.fn()}
        />
      );

      const paneEl = screen.getByTestId('dock-pane-dleaf_1');
      expect(paneEl).toBeInTheDocument();
      expect(paneEl.getAttribute('data-is-only-pane')).toBe('true');
      expect(paneEl.getAttribute('data-is-solo')).toBe('false');
      expect(screen.queryByTestId(/dock-sash-/)).toBeNull();

      expect(capturedDockPaneProps).toHaveLength(1);
      expect(capturedDockPaneProps[0].leafId).toBe('dleaf_1');
      expect(capturedDockPaneProps[0].sessionId).toBe('session_1');
      expect(capturedDockPaneProps[0].isMaximized).toBe(false);
      expect(typeof capturedDockPaneProps[0].onToggleMaximize).toBe('function');
    });

    it('全屏最大化状态透传与 onToggleMaximize 回调分发', () => {
      const onToggleMaximize = vi.fn();
      const dock: RightToolDockState = {
        collapsed: false,
        widthRatio: 0.5,
        tree: createSingleTabTree(),
      };

      const { rerender } = render(
        <DockSplitWorkspace
          leafId="leaf_main"
          sessionId="session_1"
          dock={dock}
          isMaximized={false}
          onToggleMaximize={onToggleMaximize}
        />
      );

      const paneEl = screen.getByTestId('dock-pane-dleaf_1');
      expect(paneEl.getAttribute('data-is-maximized')).toBe('false');

      // 点击透传的 ToggleMaximize 按钮
      const maxBtn = screen.getByTestId('btn-toggle-maximize-dleaf_1');
      fireEvent.click(maxBtn);
      expect(onToggleMaximize).toHaveBeenCalledTimes(1);

      // 切换为 maximized=true
      rerender(
        <DockSplitWorkspace
          leafId="leaf_main"
          sessionId="session_1"
          dock={dock}
          isMaximized={true}
          onToggleMaximize={onToggleMaximize}
        />
      );
      expect(paneEl.getAttribute('data-is-maximized')).toBe('true');
    });
  });

  describe('3. 二分屏渲染与分割线布局', () => {
    it('水平左右二分屏：渲染 2 个 DockPane (isOnlyPane=false) 与 1 个水平 Sash', () => {
      const dock: RightToolDockState = {
        collapsed: false,
        widthRatio: 0.5,
        tree: createSplitTree('horizontal'),
      };

      render(
        <DockSplitWorkspace
          leafId="leaf_main"
          sessionId="session_1"
          dock={dock}
          isMaximized={false}
          onToggleMaximize={vi.fn()}
        />
      );

      expect(capturedDockPaneProps).toHaveLength(2);
      expect(capturedDockPaneProps[0].isOnlyPane).toBe(false);
      expect(capturedDockPaneProps[1].isOnlyPane).toBe(false);

      expect(capturedSashProps).toHaveLength(1);
      expect(capturedSashProps[0].branch.direction).toBe('horizontal');
      expect(capturedSashProps[0].branch.splitRatio).toBe(0.5);
      expect(capturedSashProps[0].containerRef.current).toBeDefined();
    });

    it('垂直上下二分屏：渲染 2 个 DockPane 与 1 个垂直 Sash', () => {
      const dock: RightToolDockState = {
        collapsed: false,
        widthRatio: 0.5,
        tree: createSplitTree('vertical'),
      };

      render(
        <DockSplitWorkspace
          leafId="leaf_main"
          sessionId="session_1"
          dock={dock}
          isMaximized={false}
          onToggleMaximize={vi.fn()}
        />
      );

      expect(capturedSashProps).toHaveLength(1);
      expect(capturedSashProps[0].branch.direction).toBe('vertical');
    });
  });

  describe('4. 窗格操作原子调度与纯函数映射', () => {
    it('onSelectTab: 调用 activateDockTab 更新 activeTabId 并提交', () => {
      const onUpdateDock = vi.fn();
      let tree = createSingleTabTree('terminal', 'dtab_1');
      const addRes = openToolInDock(tree, {
        viewId: 'preview',
        targetLeafId: 'dleaf_1',
      });
      tree = addRes.tree;
      const secondTabId = addRes.tabId;

      const dock: RightToolDockState = {
        collapsed: false,
        widthRatio: 0.5,
        tree,
      };

      render(
        <DockSplitWorkspace
          leafId="leaf_main"
          sessionId="session_1"
          dock={dock}
          isMaximized={false}
          onToggleMaximize={vi.fn()}
          onUpdateDock={onUpdateDock}
        />
      );

      // 触发选择第二个 tab
      capturedDockPaneProps[0].onSelectTab(secondTabId);

      expect(onUpdateDock).toHaveBeenCalledTimes(1);
      const nextTree: DockTree = onUpdateDock.mock.calls[0][0].tree;
      expect((nextTree.root as DockLeaf).activeTabId).toBe(secondTabId);
    });

    it('onCloseTab: 关闭终端标签时销毁 ConPTY 进程，全部关闭后自动折叠 collapsed=true', () => {
      const onUpdateDock = vi.fn();
      const dock: RightToolDockState = {
        collapsed: false,
        widthRatio: 0.5,
        tree: createSingleTabTree('terminal', 'dtab_term_1'),
      };

      render(
        <DockSplitWorkspace
          leafId="leaf_main"
          sessionId="session_1"
          dock={dock}
          isMaximized={false}
          onToggleMaximize={vi.fn()}
          onUpdateDock={onUpdateDock}
        />
      );

      capturedDockPaneProps[0].onCloseTab('dtab_term_1');

      // 验证精准销毁 ConPTY 句柄
      expect(treeLeafModel.killDockTerminalPty).toHaveBeenCalledWith(
        'dtab_term_1',
        'session_1'
      );
      expect(onUpdateDock).toHaveBeenCalledTimes(1);
      const patch = onUpdateDock.mock.calls[0][0];
      expect(patch.collapsed).toBe(true);
    });

    it('onAddTab: 在指定叶片中添加新工具', () => {
      const onUpdateDock = vi.fn();
      const dock: RightToolDockState = {
        collapsed: false,
        widthRatio: 0.5,
        tree: createSingleTabTree(),
      };

      render(
        <DockSplitWorkspace
          leafId="leaf_main"
          sessionId="session_1"
          dock={dock}
          isMaximized={false}
          onToggleMaximize={vi.fn()}
          onUpdateDock={onUpdateDock}
        />
      );

      capturedDockPaneProps[0].onAddTab('diff');

      expect(onUpdateDock).toHaveBeenCalledTimes(1);
      const nextTree: DockTree = onUpdateDock.mock.calls[0][0].tree;
      const leaf = nextTree.root as DockLeaf;
      expect(leaf.tabs).toHaveLength(2);
      expect(leaf.tabs[1].viewId).toBe('diff');
    });

    it('onFocusPane: 切换当前全局焦点叶片 activeDockLeafId', () => {
      const onUpdateDock = vi.fn();
      const tree = {
        ...createSplitTree('horizontal'),
        activeDockLeafId: 'dleaf_1',
      };
      const dock: RightToolDockState = {
        collapsed: false,
        widthRatio: 0.5,
        tree,
      };

      render(
        <DockSplitWorkspace
          leafId="leaf_main"
          sessionId="session_1"
          dock={dock}
          isMaximized={false}
          onToggleMaximize={vi.fn()}
          onUpdateDock={onUpdateDock}
        />
      );

      const secondLeafId = capturedDockPaneProps[1].leafId;
      capturedDockPaneProps[1].onFocusPane();

      expect(onUpdateDock).toHaveBeenCalledTimes(1);
      const nextTree: DockTree = onUpdateDock.mock.calls[0][0].tree;
      expect(nextTree.activeDockLeafId).toBe(secondLeafId);
    });
  });

  describe('5. 二叉切分与标签克隆', () => {
    it('onSplitRight: 水平切分并克隆当前激活 Tab 到新窗格', () => {
      const onUpdateDock = vi.fn();
      const dock: RightToolDockState = {
        collapsed: false,
        widthRatio: 0.5,
        tree: createSingleTabTree('preview', 'dtab_prev_1'),
      };

      render(
        <DockSplitWorkspace
          leafId="leaf_main"
          sessionId="session_1"
          dock={dock}
          isMaximized={false}
          onToggleMaximize={vi.fn()}
          onUpdateDock={onUpdateDock}
        />
      );

      capturedDockPaneProps[0].onSplitRight();

      expect(onUpdateDock).toHaveBeenCalledTimes(1);
      const nextTree: DockTree = onUpdateDock.mock.calls[0][0].tree;
      expect(nextTree.root.type).toBe('branch');
      if (nextTree.root.type === 'branch') {
        expect(nextTree.root.direction).toBe('horizontal');
        const child1 = nextTree.root.children[1] as DockLeaf;
        expect(child1.tabs[0].viewId).toBe('preview');
        // 克隆生成全新的 tabId，杜绝引用调和碰撞
        expect(child1.tabs[0].tabId).not.toBe('dtab_prev_1');
      }
    });

    it('onSplitDown: 垂直向下切分窗格', () => {
      const onUpdateDock = vi.fn();
      const dock: RightToolDockState = {
        collapsed: false,
        widthRatio: 0.5,
        tree: createSingleTabTree(),
      };

      render(
        <DockSplitWorkspace
          leafId="leaf_main"
          sessionId="session_1"
          dock={dock}
          isMaximized={false}
          onToggleMaximize={vi.fn()}
          onUpdateDock={onUpdateDock}
        />
      );

      capturedDockPaneProps[0].onSplitDown();

      expect(onUpdateDock).toHaveBeenCalledTimes(1);
      const nextTree: DockTree = onUpdateDock.mock.calls[0][0].tree;
      expect(nextTree.root.type).toBe('branch');
      if (nextTree.root.type === 'branch') {
        expect(nextTree.root.direction).toBe('vertical');
      }
    });
  });

  describe('6. Solo 模式状态切换与渲染拦截', () => {
    it('切换 Solo 模式：只渲染 Solo 窗格，隐藏 Sash，并在再次切换时退出', () => {
      const dock: RightToolDockState = {
        collapsed: false,
        widthRatio: 0.5,
        tree: createSplitTree('horizontal'),
      };

      const { rerender } = render(
        <DockSplitWorkspace
          leafId="leaf_main"
          sessionId="session_1"
          dock={dock}
          isMaximized={false}
          onToggleMaximize={vi.fn()}
        />
      );

      expect(screen.getAllByTestId(/dock-pane-/)).toHaveLength(2);
      expect(screen.getByTestId(/dock-sash-/)).toBeInTheDocument();

      // 1. 触发第一个窗格进入 Solo 模式
      act(() => {
        capturedDockPaneProps[0].onToggleSolo();
      });

      rerender(
        <DockSplitWorkspace
          leafId="leaf_main"
          sessionId="session_1"
          dock={dock}
          isMaximized={false}
          onToggleMaximize={vi.fn()}
        />
      );

      // 只渲染 1 个窗格，且 isSolo=true，所有 Sash 隐藏
      expect(screen.getAllByTestId(/dock-pane-/)).toHaveLength(1);
      expect(
        screen.getByTestId('dock-pane-dleaf_1').getAttribute('data-is-solo')
      ).toBe('true');
      expect(screen.queryByTestId(/dock-sash-/)).toBeNull();

      // 2. 再次触发退出 Solo 模式
      act(() => {
        capturedDockPaneProps[capturedDockPaneProps.length - 1].onToggleSolo();
      });

      rerender(
        <DockSplitWorkspace
          leafId="leaf_main"
          sessionId="session_1"
          dock={dock}
          isMaximized={false}
          onToggleMaximize={vi.fn()}
        />
      );

      expect(screen.getAllByTestId(/dock-pane-/)).toHaveLength(2);
      expect(screen.getByTestId(/dock-sash-/)).toBeInTheDocument();
    });
  });

  describe('7. 窗格修剪关闭 (Close Pane)', () => {
    it('多窗格下 onClosePane 修剪当前窗格并提升兄弟节点', () => {
      const onUpdateDock = vi.fn();
      const dock: RightToolDockState = {
        collapsed: false,
        widthRatio: 0.5,
        tree: createSplitTree('horizontal'),
      };

      render(
        <DockSplitWorkspace
          leafId="leaf_main"
          sessionId="session_1"
          dock={dock}
          isMaximized={false}
          onToggleMaximize={vi.fn()}
          onUpdateDock={onUpdateDock}
        />
      );

      const targetLeafId = capturedDockPaneProps[0].leafId;
      capturedDockPaneProps[0].onClosePane();

      expect(onUpdateDock).toHaveBeenCalledTimes(1);
      const nextTree: DockTree = onUpdateDock.mock.calls[0][0].tree;
      // 修剪后树退化为单叶
      expect(nextTree.root.type).toBe('leaf');
      expect(nextTree.root.id).not.toBe(targetLeafId);
    });

    it('单窗格下 onClosePane 收起整个 Dock（不移除唯一窗格）', () => {
      const onUpdateDock = vi.fn();
      const dock: RightToolDockState = {
        collapsed: false,
        widthRatio: 0.5,
        tree: createSingleTabTree(),
      };

      render(
        <DockSplitWorkspace
          leafId="leaf_main"
          sessionId="session_1"
          dock={dock}
          isMaximized={false}
          onToggleMaximize={vi.fn()}
          onUpdateDock={onUpdateDock}
        />
      );

      capturedDockPaneProps[0].onClosePane();
      expect(onUpdateDock).toHaveBeenCalledWith({ collapsed: true });
    });
  });

  describe('8. 分割线调比与提交', () => {
    it('Sash 触发 onCommitRatio 时调用 resizeDockBranch 并提交新比例', () => {
      const onUpdateDock = vi.fn();
      const dock: RightToolDockState = {
        collapsed: false,
        widthRatio: 0.5,
        tree: createSplitTree('horizontal'),
      };

      render(
        <DockSplitWorkspace
          leafId="leaf_main"
          sessionId="session_1"
          dock={dock}
          isMaximized={false}
          onToggleMaximize={vi.fn()}
          onUpdateDock={onUpdateDock}
        />
      );

      const branchId = capturedSashProps[0].branch.branchId;
      capturedSashProps[0].onCommitRatio(branchId, 0.65);

      expect(onUpdateDock).toHaveBeenCalledTimes(1);
      const nextTree: DockTree = onUpdateDock.mock.calls[0][0].tree;
      if (nextTree.root.type === 'branch') {
        expect(nextTree.root.splitRatio).toBe(0.65);
      }
    });
  });

  describe('9. 状态提交通道与回退', () => {
    it('缺省 onUpdateDock 时自动回退调用 storeAccess.updateLeafDock', () => {
      const dock: RightToolDockState = {
        collapsed: false,
        widthRatio: 0.5,
        tree: createSingleTabTree(),
      };

      render(
        <DockSplitWorkspace
          leafId="leaf_outer_123"
          sessionId="session_1"
          dock={dock}
          isMaximized={false}
          onToggleMaximize={vi.fn()}
        />
      );

      capturedDockPaneProps[0].onSplitRight();

      expect(storeAccess.updateLeafDock).toHaveBeenCalledWith(
        'leaf_outer_123',
        expect.objectContaining({ tree: expect.any(Object) })
      );
    });
  });

  describe('10. 旧版数据向后兼容冷迁移', () => {
    it('输入缺少 tree 字段的 legacy dock 时，无损迁移为包含对应 tabs 的 DockTree', () => {
      const legacyDock = {
        collapsed: false,
        widthRatio: 0.45,
        openPanelIds: ['terminal', 'preview'],
        activePanelId: 'preview',
      } as unknown as RightToolDockState;

      render(
        <DockSplitWorkspace
          leafId="leaf_legacy"
          sessionId="session_1"
          dock={legacyDock}
          isMaximized={false}
          onToggleMaximize={vi.fn()}
        />
      );

      expect(capturedDockPaneProps).toHaveLength(1);
      const flatLeaf = capturedDockPaneProps[0].flatLeaf;
      expect(flatLeaf.tabs).toHaveLength(2);
      expect(flatLeaf.tabs[0].viewId).toBe('terminal');
      expect(flatLeaf.tabs[1].viewId).toBe('preview');
      expect(flatLeaf.activeTabId).toBe(flatLeaf.tabs[1].tabId);
    });
  });
});
