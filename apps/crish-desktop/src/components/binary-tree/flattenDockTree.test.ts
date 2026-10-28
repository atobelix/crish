import { describe, expect, it } from 'vitest';
import {
  createDefaultDockLeaf,
  createDefaultDockTree,
  createSpatialBranch,
  createToolTab,
  openToolInDock,
  splitDockLeaf,
  type DockLeaf,
  type DockTree,
} from '../../store/layout-tree/dockLayoutModel';
import { flattenDockTree } from './flattenDockTree';

describe('flattenDockTree 几何展平与守恒断言', () => {
  it('1. 单叶退化测试：单个空叶或有 Tab 的叶片，输出 1 个 FlatDockLeaf，rect = [0, 0, 1, 1]，branches.length === 0', () => {
    // 1.1 单个空叶
    const emptyTree: DockTree = createDefaultDockTree();
    const emptyLayout = flattenDockTree(emptyTree);

    expect(emptyLayout.leaves).toHaveLength(1);
    expect(emptyLayout.branches).toHaveLength(0);
    expect(emptyLayout.leaves[0]).toEqual({
      leafId: 'dleaf_default',
      tabs: [],
      activeTabId: null,
      rect: { x: 0, y: 0, width: 1, height: 1 },
      isActive: false,
    });

    // 1.2 单个带 Tab 的叶片
    const { tree: treeWithTab } = openToolInDock(emptyTree, {
      viewId: 'terminal',
      title: '终端 1',
    });
    const layoutWithTab = flattenDockTree(treeWithTab);

    expect(layoutWithTab.leaves).toHaveLength(1);
    expect(layoutWithTab.branches).toHaveLength(0);
    expect(layoutWithTab.leaves[0].rect).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
    expect(layoutWithTab.leaves[0].tabs).toHaveLength(1);
    expect(layoutWithTab.leaves[0].tabs[0].viewId).toBe('terminal');
    expect(layoutWithTab.leaves[0].isActive).toBe(true);
  });

  it('2. 左右分屏测试：比例 0.6，输出 2 个 Leaf（宽 0.6 和 0.4，高 1.0），输出 1 个垂直 Sash（x = 0.6, y = 0, length = 1.0, direction = horizontal）', () => {
    const leafLeft: DockLeaf = {
      type: 'leaf',
      id: 'leaf_left',
      tabs: [createToolTab('terminal', { title: '左终端' })],
      activeTabId: 'dtab_left',
    };
    const leafRight: DockLeaf = {
      type: 'leaf',
      id: 'leaf_right',
      tabs: [createToolTab('preview', { title: '右预览' })],
      activeTabId: 'dtab_right',
    };

    const rootBranch = createSpatialBranch(
      'horizontal',
      leafLeft,
      leafRight,
      0.6,
      'b_split_h'
    );

    const tree: DockTree = {
      root: rootBranch,
      activeDockLeafId: 'leaf_left',
      version: 2,
    };

    const layout = flattenDockTree(tree);

    expect(layout.leaves).toHaveLength(2);
    expect(layout.branches).toHaveLength(1);

    // 左右窗格几何断言
    const [firstLeaf, secondLeaf] = layout.leaves;
    expect(firstLeaf.leafId).toBe('leaf_left');
    expect(firstLeaf.rect).toEqual({ x: 0, y: 0, width: 0.6, height: 1.0 });

    expect(secondLeaf.leafId).toBe('leaf_right');
    expect(secondLeaf.rect).toEqual({ x: 0.6, y: 0, width: 0.4, height: 1.0 });

    // Sash 分割线断言
    const branch = layout.branches[0];
    expect(branch.branchId).toBe('b_split_h');
    expect(branch.direction).toBe('horizontal');
    expect(branch.splitRatio).toBe(0.6);
    expect(branch.rect).toEqual({ x: 0, y: 0, width: 1.0, height: 1.0 });
    expect(branch.sash).toEqual({
      id: 'sash_b_split_h',
      x: 0.6,
      y: 0,
      length: 1.0,
      direction: 'horizontal',
    });
  });

  it('3. 上下分屏测试：比例 0.5，输出 2 个 Leaf（宽 1.0，高 0.5 和 0.5），输出 1 个水平 Sash（x = 0, y = 0.5, length = 1.0, direction = vertical）', () => {
    const leafTop: DockLeaf = {
      type: 'leaf',
      id: 'leaf_top',
      tabs: [createToolTab('files', { title: '文件树' })],
      activeTabId: 'dtab_top',
    };
    const leafBottom: DockLeaf = {
      type: 'leaf',
      id: 'leaf_bottom',
      tabs: [createToolTab('diff', { title: '代码对比' })],
      activeTabId: 'dtab_bottom',
    };

    const rootBranch = createSpatialBranch(
      'vertical',
      leafTop,
      leafBottom,
      0.5,
      'b_split_v'
    );

    const tree: DockTree = {
      root: rootBranch,
      activeDockLeafId: 'leaf_bottom',
      version: 2,
    };

    const layout = flattenDockTree(tree);

    expect(layout.leaves).toHaveLength(2);
    expect(layout.branches).toHaveLength(1);

    // 上下窗格几何断言
    const [topLeaf, bottomLeaf] = layout.leaves;
    expect(topLeaf.leafId).toBe('leaf_top');
    expect(topLeaf.rect).toEqual({ x: 0, y: 0, width: 1.0, height: 0.5 });

    expect(bottomLeaf.leafId).toBe('leaf_bottom');
    expect(bottomLeaf.rect).toEqual({ x: 0, y: 0.5, width: 1.0, height: 0.5 });

    // Sash 分割线断言
    const branch = layout.branches[0];
    expect(branch.branchId).toBe('b_split_v');
    expect(branch.direction).toBe('vertical');
    expect(branch.splitRatio).toBe(0.5);
    expect(branch.rect).toEqual({ x: 0, y: 0, width: 1.0, height: 1.0 });
    expect(branch.sash).toEqual({
      id: 'sash_b_split_v',
      x: 0,
      y: 0.5,
      length: 1.0,
      direction: 'vertical',
    });
  });

  it('4. 复杂 4 窗格嵌套切分：断言面积守恒 Σ(w × h) = 1.0，且两两无重叠', () => {
    // 构造嵌套布局：
    //           Root (H, 0.4)
    //         /               \
    //   BranchLeft (V, 0.7)  BranchRight (V, 0.3)
    //      /       \            /        \
    //  LeafA      LeafB      LeafC      LeafD
    const leafA: DockLeaf = {
      type: 'leaf',
      id: 'leaf_A',
      tabs: [createToolTab('terminal')],
      activeTabId: 'tab_a',
    };
    const leafB: DockLeaf = {
      type: 'leaf',
      id: 'leaf_B',
      tabs: [createToolTab('preview')],
      activeTabId: 'tab_b',
    };
    const leafC: DockLeaf = {
      type: 'leaf',
      id: 'leaf_C',
      tabs: [createToolTab('files')],
      activeTabId: 'tab_c',
    };
    const leafD: DockLeaf = {
      type: 'leaf',
      id: 'leaf_D',
      tabs: [createToolTab('diff')],
      activeTabId: 'tab_d',
    };

    const branchLeft = createSpatialBranch(
      'vertical',
      leafA,
      leafB,
      0.7,
      'b_left'
    );
    const branchRight = createSpatialBranch(
      'vertical',
      leafC,
      leafD,
      0.3,
      'b_right'
    );
    const rootBranch = createSpatialBranch(
      'horizontal',
      branchLeft,
      branchRight,
      0.4,
      'b_root'
    );

    const tree: DockTree = {
      root: rootBranch,
      activeDockLeafId: 'leaf_B',
      version: 2,
    };

    const layout = flattenDockTree(tree);

    expect(layout.leaves).toHaveLength(4);
    expect(layout.branches).toHaveLength(3);

    // 4.1 断言面积守恒 Σ(width * height) === 1.0
    const totalArea = layout.leaves.reduce(
      (sum, item) => sum + item.rect.width * item.rect.height,
      0
    );
    expect(totalArea).toBeCloseTo(1.0, 5);

    // 4.2 断言所有叶片矩形完全位于 [0, 1] 视口边界内
    for (const item of layout.leaves) {
      expect(item.rect.x).toBeGreaterThanOrEqual(0);
      expect(item.rect.y).toBeGreaterThanOrEqual(0);
      expect(item.rect.x + item.rect.width).toBeLessThanOrEqual(1.0001);
      expect(item.rect.y + item.rect.height).toBeLessThanOrEqual(1.0001);
      expect(item.rect.width).toBeGreaterThan(0);
      expect(item.rect.height).toBeGreaterThan(0);
    }

    // 4.3 断言两两矩形内部无重叠 (overlap area === 0)
    for (let i = 0; i < layout.leaves.length; i++) {
      for (let j = i + 1; j < layout.leaves.length; j++) {
        const r1 = layout.leaves[i].rect;
        const r2 = layout.leaves[j].rect;

        const interWidth = Math.max(
          0,
          Math.min(r1.x + r1.width, r2.x + r2.width) - Math.max(r1.x, r2.x)
        );
        const interHeight = Math.max(
          0,
          Math.min(r1.y + r1.height, r2.y + r2.height) - Math.max(r1.y, r2.y)
        );
        const interArea = interWidth * interHeight;

        expect(interArea).toBeLessThan(1e-6);
      }
    }
  });

  it('5. 单窗格最大化 (Solo Mode) 测试：传入 soloLeafId，断言该窗格 rect = [0, 0, 1, 1]，且 branches.length === 0', () => {
    const leafA: DockLeaf = {
      type: 'leaf',
      id: 'leaf_A',
      tabs: [createToolTab('terminal')],
      activeTabId: 'tab_a',
    };
    const leafB: DockLeaf = {
      type: 'leaf',
      id: 'leaf_B',
      tabs: [createToolTab('preview')],
      activeTabId: 'tab_b',
    };
    const tree: DockTree = {
      root: createSpatialBranch('horizontal', leafA, leafB, 0.5, 'b_root'),
      activeDockLeafId: 'leaf_A',
      version: 2,
    };

    // 5.1 激活 leaf_B 的 Solo Mode
    const soloLayoutB = flattenDockTree(tree, 'leaf_B');
    expect(soloLayoutB.leaves).toHaveLength(1);
    expect(soloLayoutB.branches).toHaveLength(0);
    expect(soloLayoutB.leaves[0].leafId).toBe('leaf_B');
    expect(soloLayoutB.leaves[0].rect).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
    expect(soloLayoutB.leaves[0].isActive).toBe(false); // activeDockLeafId 是 leaf_A

    // 5.2 激活 leaf_A 的 Solo Mode
    const soloLayoutA = flattenDockTree(tree, 'leaf_A');
    expect(soloLayoutA.leaves).toHaveLength(1);
    expect(soloLayoutA.branches).toHaveLength(0);
    expect(soloLayoutA.leaves[0].leafId).toBe('leaf_A');
    expect(soloLayoutA.leaves[0].rect).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
    expect(soloLayoutA.leaves[0].isActive).toBe(true);

    // 5.3 传入不存在的 soloLeafId，应安全降级为完整二叉树展平
    const fallbackLayout = flattenDockTree(tree, 'non_existent_leaf');
    expect(fallbackLayout.leaves).toHaveLength(2);
    expect(fallbackLayout.branches).toHaveLength(1);

    // 5.4 传入 null / undefined，正常展平
    expect(flattenDockTree(tree, null).leaves).toHaveLength(2);
    expect(flattenDockTree(tree, undefined).leaves).toHaveLength(2);
  });

  it('6. 活动窗格判定断言：isActive === true 精确匹配 tree.activeDockLeafId', () => {
    const leaf1: DockLeaf = {
      type: 'leaf',
      id: 'leaf_1',
      tabs: [createToolTab('terminal')],
      activeTabId: 't1',
    };
    const leaf2: DockLeaf = {
      type: 'leaf',
      id: 'leaf_2',
      tabs: [createToolTab('preview')],
      activeTabId: 't2',
    };
    const leaf3: DockLeaf = {
      type: 'leaf',
      id: 'leaf_3',
      tabs: [createToolTab('files')],
      activeTabId: 't3',
    };

    const tree: DockTree = {
      root: createSpatialBranch(
        'horizontal',
        leaf1,
        createSpatialBranch('vertical', leaf2, leaf3, 0.5, 'b_sub'),
        0.5,
        'b_main'
      ),
      activeDockLeafId: 'leaf_2',
      version: 2,
    };

    const layout = flattenDockTree(tree);

    const activeLeaves = layout.leaves.filter((l) => l.isActive);
    expect(activeLeaves).toHaveLength(1);
    expect(activeLeaves[0].leafId).toBe('leaf_2');

    const inactiveLeaves = layout.leaves.filter((l) => !l.isActive);
    expect(inactiveLeaves).toHaveLength(2);
    expect(inactiveLeaves.map((l) => l.leafId).sort()).toEqual([
      'leaf_1',
      'leaf_3',
    ]);

    // 若 activeDockLeafId 为 null，则全部为 false
    const treeNoActive: DockTree = {
      ...tree,
      activeDockLeafId: null,
    };
    const layoutNoActive = flattenDockTree(treeNoActive);
    expect(layoutNoActive.leaves.every((l) => !l.isActive)).toBe(true);
  });

  it('7. 与 dockLayoutModel 纯函数切分操作的集成联动测试', () => {
    // 从空树开始：打开终端 -> 切分出预览
    let tree: DockTree = createDefaultDockTree();
    const openRes = openToolInDock(tree, {
      viewId: 'terminal',
      title: '主终端',
    });
    tree = openRes.tree;

    const initialLeafId = tree.activeDockLeafId!;
    const newTab = createToolTab('preview', { title: 'Web 预览' });
    tree = splitDockLeaf(tree, initialLeafId, 'horizontal', newTab, 0.65);

    const layout = flattenDockTree(tree);

    expect(layout.leaves).toHaveLength(2);
    expect(layout.branches).toHaveLength(1);

    // 验证新切出的窗格被设置为当前激活窗格
    const activeLeaf = layout.leaves.find((l) => l.isActive);
    expect(activeLeaf).toBeDefined();
    expect(activeLeaf?.tabs[0].viewId).toBe('preview');

    // 验证几何分割线
    expect(layout.branches[0].splitRatio).toBe(0.65);
    expect(layout.branches[0].sash.x).toBe(0.65);
  });
});
