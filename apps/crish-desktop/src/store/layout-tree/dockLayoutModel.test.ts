import { describe, expect, it } from 'vitest';
import {
  activateDockLeaf,
  activateDockTab,
  assertDockLeafInvariants,
  assertDockTreeInvariants,
  closeDockLeaf,
  closeDockTab,
  collectDockTabs,
  collectSpatialLeaves,
  createDefaultDockLeaf,
  createDefaultDockTree,
  createToolTab,
  findLeafContainingTab,
  findSpatialNode,
  findToolTab,
  getActiveDockTab,
  isDockTreeEmpty,
  isSpatialBranch,
  isSpatialLeaf,
  mintDockLeafId,
  mintToolTabId,
  moveDockTab,
  openToolInDock,
  resizeDockBranch,
  splitDockLeaf,
  type DockLeaf,
  type DockTree,
  type ToolTab,
} from './dockLayoutModel';

describe('dockLayoutModel - 充要不变量与生成器', () => {
  it('mintToolTabId 满足前缀与唯一性规范', () => {
    const id1 = mintToolTabId('term');
    const id2 = mintToolTabId('term');
    expect(id1).toMatch(/^dtab_term_[0-9a-z]+_[0-9a-z]+$/);
    expect(id2).toMatch(/^dtab_term_[0-9a-z]+_[0-9a-z]+$/);
    expect(id1).not.toBe(id2);

    const defaultId = mintToolTabId();
    expect(defaultId).toMatch(/^dtab_[0-9a-z]+_[0-9a-z]+$/);
  });

  it('mintDockLeafId 满足前缀规范', () => {
    const leafId = mintDockLeafId();
    expect(leafId).toMatch(/^dleaf_[0-9a-z]+_[0-9a-z]+$/);
  });

  it('createToolTab 正交封装实体且冻结 params', () => {
    const tab = createToolTab({
      viewId: 'file-viewer',
      title: 'Editor',
      params: { filePath: '/src/main.ts', mode: 'plain' },
    });
    expect(tab.viewId).toBe('file-viewer');
    expect(tab.title).toBe('Editor');
    expect(tab.tabId).toMatch(/^dtab_file-viewer_/);
    expect(tab.params).toEqual({ filePath: '/src/main.ts', mode: 'plain' });
    expect(Object.isFrozen(tab.params)).toBe(true);
  });

  it('createDefaultDockLeaf 与 createDefaultDockTree 处于纯净单叶空态', () => {
    const leaf = createDefaultDockLeaf();
    expect(leaf.type).toBe('leaf');
    expect(leaf.tabs).toEqual([]);
    expect(leaf.activeTabId).toBeNull();
    assertDockLeafInvariants(leaf);

    const tree = createDefaultDockTree();
    expect(tree.version).toBe(2);
    expect(tree.activeDockLeafId).toBeNull();
    expect(isSpatialLeaf(tree.root)).toBe(true);
    expect(isDockTreeEmpty(tree)).toBe(true);
    assertDockTreeInvariants(tree);
  });

  it('assertDockLeafInvariants 充要不变量断言', () => {
    // 空 tabs 且 activeTabId === null：合法
    expect(() =>
      assertDockLeafInvariants({
        type: 'leaf',
        id: 'leaf_1',
        tabs: [],
        activeTabId: null,
      })
    ).not.toThrow();

    // 空 tabs 但 activeTabId !== null：非法
    expect(() =>
      assertDockLeafInvariants({
        type: 'leaf',
        id: 'leaf_1',
        tabs: [],
        activeTabId: 'dtab_invalid',
      })
    ).toThrow(/空窗格 activeTabId 必须为 null/);

    // 非空 tabs 但 activeTabId === null：非法
    const dummyTab = createToolTab({ viewId: 'terminal', tabId: 'tab_1' });
    expect(() =>
      assertDockLeafInvariants({
        type: 'leaf',
        id: 'leaf_1',
        tabs: [dummyTab],
        activeTabId: null,
      })
    ).toThrow(/非空窗格 activeTabId 不能为 null/);

    // 非空 tabs 且 activeTabId 不存在于 tabs 中：非法
    expect(() =>
      assertDockLeafInvariants({
        type: 'leaf',
        id: 'leaf_1',
        tabs: [dummyTab],
        activeTabId: 'tab_other',
      })
    ).toThrow(/必须属于 tabs 列表/);

    // 非空 tabs 且 activeTabId 匹配：合法
    expect(() =>
      assertDockLeafInvariants({
        type: 'leaf',
        id: 'leaf_1',
        tabs: [dummyTab],
        activeTabId: 'tab_1',
      })
    ).not.toThrow();
  });
});

describe('dockLayoutModel - 工具打开与单例/多实例调度', () => {
  it('单例工具打开测试：连续两次 openToolInDock(..., { isSingleton: true })，Tab 数量不变且仅聚焦', () => {
    let tree = createDefaultDockTree();

    // 第一次打开 files
    const res1 = openToolInDock(tree, {
      viewId: 'files',
      title: '工作区文件',
      isSingleton: true,
    });
    tree = res1.tree;
    const tabId1 = res1.tabId;

    expect(isDockTreeEmpty(tree)).toBe(false);
    let allTabs = collectDockTabs(tree);
    expect(allTabs.length).toBe(1);
    expect(allTabs[0].tabId).toBe(tabId1);
    expect(allTabs[0].viewId).toBe('files');
    expect(tree.activeDockLeafId).toBe(tree.root.id);

    // 第二次打开 files (isSingleton: true)
    const res2 = openToolInDock(tree, {
      viewId: 'files',
      title: '工作区文件 (更新)',
      isSingleton: true,
    });
    tree = res2.tree;

    allTabs = collectDockTabs(tree);
    expect(allTabs.length).toBe(1);
    expect(res2.tabId).toBe(tabId1);
    expect(allTabs[0].title).toBe('工作区文件 (更新)');
    expect(tree.activeDockLeafId).toBe(tree.root.id);
  });

  it('同路径 file-viewer 热更新测试：初次 plain 再次 diff，TabId 保持不变且 params.mode 就地更新', () => {
    let tree = createDefaultDockTree();

    const filePath = 'C:/workspace/project/src/index.ts';

    // 初次打开 file-viewer (mode: plain)
    const res1 = openToolInDock(tree, {
      viewId: 'file-viewer',
      title: 'index.ts',
      params: { filePath, mode: 'plain', line: 10 },
    });
    tree = res1.tree;
    const tabId1 = res1.tabId;

    let tab = findToolTab(tree, tabId1)?.tab;
    expect(tab).toBeDefined();
    expect(tab?.params?.mode).toBe('plain');
    expect(tab?.params?.filePath).toBe(filePath);

    // 再次打开同一路径 (Windows 路径反斜杠测试归一化匹配)
    const normalizedQueryPath = 'C:\\workspace\\project\\src\\index.ts';
    const res2 = openToolInDock(tree, {
      viewId: 'file-viewer',
      params: { filePath: normalizedQueryPath, mode: 'diff' },
    });
    tree = res2.tree;

    expect(res2.tabId).toBe(tabId1); // tabId 保持恒定不变
    const tabs = collectDockTabs(tree);
    expect(tabs.length).toBe(1);

    tab = findToolTab(tree, tabId1)?.tab;
    expect(tab?.params?.mode).toBe('diff');
    expect(tab?.params?.filePath).toBe(filePath);
    expect(tab?.params?.line).toBe(10); // 保留已有参数
  });

  it('file-viewer initialMode 契约热更新：初次 plain 再次 diff，自动聚焦并就地热更新 initialMode', () => {
    const tree = createDefaultDockTree();
    const filePath = 'C:/workspace/project/src/model.ts';

    const res1 = openToolInDock(tree, {
      viewId: 'file-viewer',
      title: 'model.ts',
      params: { filePath, initialMode: 'plain' },
    });
    expect(res1.tabId).toBeDefined();
    let tab = findToolTab(res1.tree, res1.tabId)?.tab;
    expect(tab?.params?.initialMode).toBe('plain');

    // 再次以 diff 模式打开同一文件 (Windows 反斜杠小写盘符)
    const res2 = openToolInDock(res1.tree, {
      viewId: 'file-viewer',
      params: {
        filePath: 'c:\\workspace\\project\\src\\model.ts',
        initialMode: 'diff',
      },
    });
    expect(res2.tabId).toBe(res1.tabId);
    expect(collectDockTabs(res2.tree).length).toBe(1);

    tab = findToolTab(res2.tree, res2.tabId)?.tab;
    expect(tab?.params?.initialMode).toBe('diff');
    expect(tab?.params?.filePath).toBe(filePath);
    expect(res2.tree.activeDockLeafId).toBe(res2.tree.root.id);
  });

  it('默认非 file-viewer 单例工具 (files, diff, overview) 无需显式传 isSingleton 即判定为单例并热更新参数', () => {
    const tree = createDefaultDockTree();

    // 1. files 单例验证
    const f1 = openToolInDock(tree, {
      viewId: 'files',
      params: { folder: '/root' },
    });
    const f2 = openToolInDock(f1.tree, {
      viewId: 'files',
      params: { folder: '/src' },
    });
    expect(f2.tabId).toBe(f1.tabId);
    expect(collectDockTabs(f2.tree).length).toBe(1);
    expect(findToolTab(f2.tree, f1.tabId)?.tab.params?.folder).toBe('/src');

    // 2. diff 单例验证
    const d1 = openToolInDock(f2.tree, {
      viewId: 'diff',
      params: { commit: 'HEAD' },
    });
    const d2 = openToolInDock(d1.tree, {
      viewId: 'diff',
      params: { commit: 'HEAD~1' },
    });
    expect(d2.tabId).toBe(d1.tabId);
    expect(collectDockTabs(d2.tree).length).toBe(2); // files + diff
    expect(findToolTab(d2.tree, d1.tabId)?.tab.params?.commit).toBe('HEAD~1');

    // 3. overview 单例验证
    const o1 = openToolInDock(d2.tree, { viewId: 'overview' });
    const o2 = openToolInDock(o1.tree, { viewId: 'overview', title: '全景' });
    expect(o2.tabId).toBe(o1.tabId);
    expect(collectDockTabs(o2.tree).length).toBe(3); // files + diff + overview
    expect(findToolTab(o2.tree, o1.tabId)?.tab.title).toBe('全景');
  });

  it('路径归一化规范：Windows 反斜杠、盘符大小写、中段./与尾部斜杠全部收敛于同一 Tab', () => {
    const tree = createDefaultDockTree();

    const canonicalPath = 'C:/workspace/conex/src/main.ts';
    const res1 = openToolInDock(tree, {
      viewId: 'file-viewer',
      params: { filePath: 'c:\\workspace\\conex\\src\\main.ts' },
    });

    const variations = [
      'C:/workspace/conex/src/./main.ts',
      'c:/workspace/conex/src/main.ts',
      'C:\\workspace\\conex\\src\\main.ts',
      'c:\\workspace\\conex\\src\\./main.ts',
      'C:/workspace/conex/src/main.ts/',
    ];

    let currentTree = res1.tree;
    for (const v of variations) {
      const res = openToolInDock(currentTree, {
        viewId: 'file-viewer',
        params: { filePath: v },
      });
      expect(res.tabId).toBe(res1.tabId);
      currentTree = res.tree;
    }

    const tabs = collectDockTabs(currentTree);
    expect(tabs.length).toBe(1);
    expect(tabs[0].params?.filePath).toBe(canonicalPath);
  });

  it('不同路径 file-viewer 作为独立标签打开', () => {
    const tree = createDefaultDockTree();

    const res1 = openToolInDock(tree, {
      viewId: 'file-viewer',
      params: { filePath: '/src/a.ts' },
    });
    const res2 = openToolInDock(res1.tree, {
      viewId: 'file-viewer',
      params: { filePath: '/src/b.ts' },
    });

    expect(res1.tabId).not.toBe(res2.tabId);
    const tabs = collectDockTabs(res2.tree);
    expect(tabs.length).toBe(2);
  });

  it('多实例工具多开测试：连续打开 2 个 terminal，生成 2 个不同 tabId 的独立 ToolTab', () => {
    const tree = createDefaultDockTree();

    const res1 = openToolInDock(tree, { viewId: 'terminal', title: '终端 1' });
    const res2 = openToolInDock(res1.tree, {
      viewId: 'terminal',
      title: '终端 2',
    });

    expect(res1.tabId).not.toBe(res2.tabId);
    const tabs = collectDockTabs(res2.tree);
    expect(tabs.length).toBe(2);
    expect(tabs[0].tabId).toBe(res1.tabId);
    expect(tabs[1].tabId).toBe(res2.tabId);
    expect(tabs[0].title).toBe('终端 1');
    expect(tabs[1].title).toBe('终端 2');
    expect(getActiveDockTab(res2.tree)?.tabId).toBe(res2.tabId);
  });
});

describe('dockLayoutModel - 分屏切分与几何二叉不变性', () => {
  it('splitDockLeaf 生成严格二叉树结构并将 activeDockLeafId 设为新窗格', () => {
    let tree = createDefaultDockTree();
    const rootLeafId = tree.root.id;

    // 先在初始叶片打开一个 terminal
    const res1 = openToolInDock(tree, { viewId: 'terminal' });
    tree = res1.tree;

    // 向右水平分屏切出新窗格，装载 preview 工具
    const previewTab = createToolTab({
      viewId: 'preview',
      params: { url: 'http://localhost:3000' },
    });
    tree = splitDockLeaf(tree, rootLeafId, 'horizontal', previewTab, 0.6);

    expect(isSpatialBranch(tree.root)).toBe(true);
    if (!isSpatialBranch(tree.root)) return;

    expect(tree.root.direction).toBe('horizontal');
    expect(tree.root.splitRatio).toBe(0.6);

    const [firstChild, secondChild] = tree.root.children;
    expect(firstChild.id).toBe(rootLeafId);
    expect(isSpatialLeaf(secondChild)).toBe(true);

    const secondLeaf = secondChild as DockLeaf;
    expect(secondLeaf.tabs.length).toBe(1);
    expect(secondLeaf.tabs[0].tabId).toBe(previewTab.tabId);
    expect(secondLeaf.activeTabId).toBe(previewTab.tabId);

    // activeDockLeafId 自动聚焦到新叶片
    expect(tree.activeDockLeafId).toBe(secondLeaf.id);

    const leaves = collectSpatialLeaves(tree.root);
    expect(leaves.length).toBe(2);
    assertDockTreeInvariants(tree);
  });

  it('连续多次切分形成复杂二叉树结构', () => {
    let tree = createDefaultDockTree();
    const leafA = tree.root.id;
    tree = openToolInDock(tree, { viewId: 'files' }).tree;

    const tabB = createToolTab({ viewId: 'terminal' });
    tree = splitDockLeaf(tree, leafA, 'vertical', tabB, 0.5);
    const leafB = tree.activeDockLeafId!;

    const tabC = createToolTab({ viewId: 'preview' });
    tree = splitDockLeaf(tree, leafB, 'horizontal', tabC, 0.4);
    const leafC = tree.activeDockLeafId!;

    const leaves = collectSpatialLeaves(tree.root);
    expect(leaves.length).toBe(3);
    expect(leaves.map((l) => l.id)).toEqual([leafA, leafB, leafC]);
    assertDockTreeInvariants(tree);
  });
});

describe('dockLayoutModel - 标签关闭与树修剪（Pruning & Collapsing）', () => {
  it('单窗格下关闭最后一个 Tab 保持单叶空态', () => {
    let tree = createDefaultDockTree();
    const leafId = tree.root.id;

    const res = openToolInDock(tree, { viewId: 'files' });
    tree = res.tree;
    const tabId = res.tabId;
    expect(collectDockTabs(tree).length).toBe(1);

    const closeRes = closeDockTab(tree, leafId, tabId);
    tree = closeRes.tree;
    expect(closeRes.closedTab?.tabId).toBe(tabId);

    expect(isSpatialLeaf(tree.root)).toBe(true);
    expect((tree.root as DockLeaf).tabs).toEqual([]);
    expect((tree.root as DockLeaf).activeTabId).toBeNull();
    expect(tree.activeDockLeafId).toBeNull();
    expect(isDockTreeEmpty(tree)).toBe(true);
    assertDockTreeInvariants(tree);
  });

  it('窗格内有多个 Tab 时关闭激活 Tab，自动就近激活相邻 Tab', () => {
    let tree = createDefaultDockTree();
    const leafId = tree.root.id;

    const res1 = openToolInDock(tree, { viewId: 'terminal', title: 'T1' });
    const res2 = openToolInDock(res1.tree, { viewId: 'terminal', title: 'T2' });
    const res3 = openToolInDock(res2.tree, { viewId: 'terminal', title: 'T3' });
    tree = res3.tree;

    expect((tree.root as DockLeaf).activeTabId).toBe(res3.tabId);

    // 关闭中间的 T2
    tree = activateDockTab(tree, leafId, res2.tabId);
    expect((tree.root as DockLeaf).activeTabId).toBe(res2.tabId);

    const closeRes = closeDockTab(tree, leafId, res2.tabId);
    tree = closeRes.tree;

    const currentLeaf = tree.root as DockLeaf;
    expect(currentLeaf.tabs.map((t) => t.tabId)).toEqual([
      res1.tabId,
      res3.tabId,
    ]);
    // 关闭 index 1 (T2) 后，优先激活原处于其右侧的 T3 (现在的 index 1)
    expect(currentLeaf.activeTabId).toBe(res3.tabId);

    // 再关闭最后的 T3
    const closeRes2 = closeDockTab(tree, leafId, res3.tabId);
    tree = closeRes2.tree;
    expect((tree.root as DockLeaf).activeTabId).toBe(res1.tabId);
  });

  it('多窗格下关闭窗格的最后一个 Tab，自动修剪空窗格并提升兄弟节点', () => {
    let tree = createDefaultDockTree();
    const leaf1Id = tree.root.id;
    const res1 = openToolInDock(tree, { viewId: 'files' });
    tree = res1.tree;

    const tab2 = createToolTab({ viewId: 'preview' });
    tree = splitDockLeaf(tree, leaf1Id, 'horizontal', tab2, 0.5);
    const leaf2Id = tree.activeDockLeafId!;

    expect(collectSpatialLeaves(tree.root).length).toBe(2);

    // 关闭 leaf2 中的唯一标签 tab2
    const closeRes = closeDockTab(tree, leaf2Id, tab2.tabId);
    tree = closeRes.tree;

    expect(closeRes.closedTab?.tabId).toBe(tab2.tabId);
    // 树结构塌缩回单叶片（leaf1 提升）
    expect(isSpatialLeaf(tree.root)).toBe(true);
    expect(tree.root.id).toBe(leaf1Id);
    expect((tree.root as DockLeaf).tabs.length).toBe(1);
    expect(tree.activeDockLeafId).toBe(leaf1Id);
    assertDockTreeInvariants(tree);
  });

  it('closeDockLeaf 直接整窗格关闭并修剪', () => {
    let tree = createDefaultDockTree();
    const leaf1Id = tree.root.id;
    tree = openToolInDock(tree, { viewId: 'files' }).tree;

    const tab2 = createToolTab({ viewId: 'terminal' });
    tree = splitDockLeaf(tree, leaf1Id, 'vertical', tab2);
    const leaf2Id = tree.activeDockLeafId!;

    const closeRes = closeDockLeaf(tree, leaf2Id);
    tree = closeRes.tree;

    expect(closeRes.closedTabs.length).toBe(1);
    expect(closeRes.closedTabs[0].tabId).toBe(tab2.tabId);
    expect(isSpatialLeaf(tree.root)).toBe(true);
    expect(tree.root.id).toBe(leaf1Id);
  });
});

describe('dockLayoutModel - 标签移动与跨窗格拖拽重排', () => {
  it('同窗格内部重排 Tab 顺序', () => {
    let tree = createDefaultDockTree();
    const leafId = tree.root.id;
    const t1 = openToolInDock(tree, { viewId: 'terminal', title: 'T1' });
    const t2 = openToolInDock(t1.tree, { viewId: 'terminal', title: 'T2' });
    const t3 = openToolInDock(t2.tree, { viewId: 'terminal', title: 'T3' });
    tree = t3.tree;

    // 将 T3 挪到最前面 index 0
    tree = moveDockTab(tree, leafId, t3.tabId, leafId, 0);

    const leaf = tree.root as DockLeaf;
    expect(leaf.tabs.map((t) => t.title)).toEqual(['T3', 'T1', 'T2']);
    expect(leaf.activeTabId).toBe(t3.tabId);
  });

  it('跨窗格移动 Tab，源窗格仍有 Tab 时保留两窗格', () => {
    let tree = createDefaultDockTree();
    const leaf1Id = tree.root.id;
    const t1 = openToolInDock(tree, { viewId: 'files' });
    const t2 = openToolInDock(t1.tree, { viewId: 'terminal' });
    tree = t2.tree;

    const p1 = createToolTab({ viewId: 'preview' });
    tree = splitDockLeaf(tree, leaf1Id, 'horizontal', p1);
    const leaf2Id = tree.activeDockLeafId!;

    // 将 t2 从 leaf1 挪到 leaf2 的开头
    tree = moveDockTab(tree, leaf1Id, t2.tabId, leaf2Id, 0);

    const leaves = collectSpatialLeaves(tree.root);
    expect(leaves.length).toBe(2);

    const l1 = leaves.find((l) => l.id === leaf1Id)!;
    const l2 = leaves.find((l) => l.id === leaf2Id)!;

    expect(l1.tabs.map((t) => t.tabId)).toEqual([t1.tabId]);
    expect(l2.tabs.map((t) => t.tabId)).toEqual([t2.tabId, p1.tabId]);
    expect(l2.activeTabId).toBe(t2.tabId);
    expect(tree.activeDockLeafId).toBe(leaf2Id);
    assertDockTreeInvariants(tree);
  });

  it('跨窗格移动 Tab 导致源窗格清空时，源窗格自动修剪塌缩', () => {
    let tree = createDefaultDockTree();
    const leaf1Id = tree.root.id;
    const t1 = openToolInDock(tree, { viewId: 'files' });
    tree = t1.tree;

    const p1 = createToolTab({ viewId: 'preview' });
    tree = splitDockLeaf(tree, leaf1Id, 'horizontal', p1);
    const leaf2Id = tree.activeDockLeafId!;

    // leaf1 只有 t1 一个 Tab，把它移入 leaf2
    tree = moveDockTab(tree, leaf1Id, t1.tabId, leaf2Id);

    // leaf1 塌缩，整树只剩 leaf2
    expect(isSpatialLeaf(tree.root)).toBe(true);
    expect(tree.root.id).toBe(leaf2Id);
    const leaf = tree.root as DockLeaf;
    expect(leaf.tabs.map((t) => t.tabId)).toEqual([p1.tabId, t1.tabId]);
    expect(leaf.activeTabId).toBe(t1.tabId);
    assertDockTreeInvariants(tree);
  });
});

describe('dockLayoutModel - 分支尺寸调节与激活切换', () => {
  it('resizeDockBranch 成功调节并自动钳制在 [0.2, 0.8] 安全物理区间', () => {
    let tree = createDefaultDockTree();
    tree = openToolInDock(tree, { viewId: 'files' }).tree;
    const p1 = createToolTab({ viewId: 'preview' });
    tree = splitDockLeaf(tree, tree.root.id, 'horizontal', p1, 0.5);

    const branchId = tree.root.id;
    // 正常调节到 0.35
    tree = resizeDockBranch(tree, branchId, 0.35);
    expect((tree.root as any).splitRatio).toBe(0.35);

    // 极端输入 0.05 钳制到 0.2
    tree = resizeDockBranch(tree, branchId, 0.05);
    expect((tree.root as any).splitRatio).toBe(0.2);

    // 极端输入 0.95 钳制到 0.8
    tree = resizeDockBranch(tree, branchId, 0.95);
    expect((tree.root as any).splitRatio).toBe(0.8);
  });

  it('activateDockLeaf 与 activateDockTab 正确切换焦点', () => {
    let tree = createDefaultDockTree();
    const leaf1Id = tree.root.id;
    const t1 = openToolInDock(tree, { viewId: 'files' });
    const t2 = openToolInDock(t1.tree, { viewId: 'terminal' });
    tree = t2.tree;

    const p1 = createToolTab({ viewId: 'preview' });
    tree = splitDockLeaf(tree, leaf1Id, 'horizontal', p1);
    const leaf2Id = tree.activeDockLeafId!;

    // 当前在 leaf2，切换回 leaf1
    tree = activateDockLeaf(tree, leaf1Id);
    expect(tree.activeDockLeafId).toBe(leaf1Id);

    // 切换 leaf1 内部激活的 Tab 为 t1
    tree = activateDockTab(tree, leaf1Id, t1.tabId);
    const leaf1 = findSpatialNode(tree.root, leaf1Id) as DockLeaf;
    expect(leaf1.activeTabId).toBe(t1.tabId);
  });

  it('findToolTab 与 findLeafContainingTab 正确命中', () => {
    let tree = createDefaultDockTree();
    const res = openToolInDock(tree, { viewId: 'overview' });
    tree = res.tree;

    const found = findToolTab(tree, res.tabId);
    expect(found?.tab.viewId).toBe('overview');
    expect(found?.leaf.id).toBe(tree.root.id);

    const leafFound = findLeafContainingTab(tree, res.tabId);
    expect(leafFound?.id).toBe(tree.root.id);

    expect(findToolTab(tree, 'non_existent')).toBeNull();
    expect(findLeafContainingTab(tree, 'non_existent')).toBeNull();
  });
});
