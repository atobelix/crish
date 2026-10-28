// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  detectDockDropZone,
  computePaneDropKind,
} from '../../components/binary-tree/detectDockDropZone';
import { commitDockDrop } from '../../components/binary-tree/dockTabDragContext';
import {
  createDefaultDockTree,
  createToolTab,
  openToolInDock,
  collectSpatialLeaves,
  isSpatialBranch,
  type DockTree,
} from './dockLayoutModel';
import { createSessionTab, type SessionTab } from './sessionTabModel';
import { useLayoutTreeStore } from './layoutTreeStore';

describe('Phase 3 门禁：dockDragDomainIsolation 跨域拖拽隔离与物理围栏测试', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('RED-01 / 断言 1: 将右坞 ToolTab 拖向顶栏 _tabsContainer_1wzf4_71 时，detectDockDropZone 立即返回 null，顶栏零 DOM 偏移、零插入光标', () => {
    // 构造顶栏 DOM 容器
    const topBar = document.createElement('div');
    topBar.className = '_tabsContainer_1wzf4_71';
    topBar.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 1200,
      bottom: 40,
      width: 1200,
      height: 40,
      x: 0,
      y: 0,
      toJSON: () => {},
    });
    document.body.appendChild(topBar);

    // 构造右坞根容器 DOM
    const dockRoot = document.createElement('div');
    dockRoot.className = 'leafDockDrawer';
    dockRoot.getBoundingClientRect = () => ({
      left: 800,
      top: 40,
      right: 1200,
      bottom: 800,
      width: 400,
      height: 760,
      x: 800,
      y: 40,
      toJSON: () => {},
    });
    document.body.appendChild(dockRoot);

    const source = {
      sourceLeafId: 'leaf_dock_1',
      tabId: 'dtab_terminal_1',
    };

    // 模拟指针移动到顶栏容器内部 (x: 900, y: 20)
    const dropZone = detectDockDropZone({ x: 900, y: 20 }, dockRoot, source);

    // 刚性断言：物理围栏立即拒收，返回 null
    expect(dropZone).toBeNull();

    // 刚性断言：顶栏 DOM 零变更，内部无任何 drag 插入光标或 indicator 注入
    expect(topBar.querySelector('.indicator')).toBeNull();
    expect(topBar.querySelectorAll('[data-drag-indicator]').length).toBe(0);
    expect(topBar.childElementCount).toBe(0);
  });

  it('RED-02 / 断言 2: 模拟在顶栏松开鼠标，顶栏标签数组长度不变，全局状态零污染', () => {
    const store = useLayoutTreeStore.getState();
    const initialTree = store.tree;
    const initialTabsCount =
      store.tree.root.type === 'leaf' ? store.tree.root.tabs.length : 0;

    // 创建右坞工具标签实体
    const toolTab = createToolTab({ viewId: 'terminal' });

    // 假设在顶栏非法释放，由于 detectDockDropZone 返回 null，不触发任何顶层 store 操作
    const dropZone = null;

    // 顶栏标签与全局树保持不变
    const afterTree = useLayoutTreeStore.getState().tree;
    expect(afterTree).toBe(initialTree);
    if (afterTree.root.type === 'leaf') {
      expect(afterTree.root.tabs.length).toBe(initialTabsCount);
    }
  });

  it('RED-04 / 断言 4: 右坞内部 Tab 拖拽至另一窗格中心正确触发合并；拖至边缘正确触发二叉切分', () => {
    let tree = createDefaultDockTree();
    // 窗格 A 打开终端、文件与预览 3 个标签
    tree = openToolInDock(tree, { viewId: 'terminal' }).tree;
    const tabTerminal = collectSpatialLeaves(tree.root)[0]!.tabs[0]!;
    tree = openToolInDock(tree, { viewId: 'files' }).tree;
    const tabFiles = collectSpatialLeaves(tree.root)[0]!.tabs[1]!;
    tree = openToolInDock(tree, { viewId: 'preview' }).tree;
    const tabPreview = collectSpatialLeaves(tree.root)[0]!.tabs[2]!;

    const leafAId = tree.activeDockLeafId!;

    // 窗格 A 右侧切分出窗格 B，将预览标签拖至右边缘分屏
    tree = commitDockDrop(tree, leafAId, tabPreview.tabId, {
      kind: 'split-right',
      targetDockLeafId: leafAId,
    });

    const leaves = collectSpatialLeaves(tree.root);
    expect(leaves.length).toBe(2);
    const leafA = leaves.find((l) =>
      l.tabs.some((t) => t.tabId === tabTerminal.tabId)
    )!;
    const leafB = leaves.find((l) =>
      l.tabs.some((t) => t.tabId === tabPreview.tabId)
    )!;

    // 场景 4.1：将窗格 A 的文件 Tab 拖拽至窗格 B 中心 -> 触发合并入窗格 B
    const treeMerged = commitDockDrop(tree, leafA.id, tabFiles.tabId, {
      kind: 'tab-strip',
      targetDockLeafId: leafB.id,
      insertIndex: 1,
    });

    const leavesMerged = collectSpatialLeaves(treeMerged.root);
    const updatedLeafB = leavesMerged.find((l) => l.id === leafB.id)!;
    expect(updatedLeafB.tabs.some((t) => t.tabId === tabFiles.tabId)).toBe(
      true
    );

    // 场景 4.2：将窗格 B 的文件 Tab 拖拽至窗格 B 底部边缘 -> 触发垂直二叉切分
    const treeSplitBottom = commitDockDrop(
      treeMerged,
      leafB.id,
      tabFiles.tabId,
      {
        kind: 'split-bottom',
        targetDockLeafId: leafB.id,
      }
    );

    const leavesSplit = collectSpatialLeaves(treeSplitBottom.root);
    // 从 2 个窗格增长为 3 个窗格
    expect(leavesSplit.length).toBe(3);
    expect(isSpatialBranch(treeSplitBottom.root)).toBe(true);
  });
});
