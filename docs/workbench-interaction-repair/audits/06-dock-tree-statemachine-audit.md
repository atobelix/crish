# 二叉树右坞工具栏展开、空树自动补全与状态机死锁解开源码级审计报告

> **审计专家**：二叉树工作区与抽屉状态机审计专家（Dock & Tree Reviewer）  
> **审计提交**：`commit f6ae63f5ff5431128c31202eeadfccfb42f8e17f`  
> **战役工作区**：`docs/workbench-interaction-repair/`  
> **关联详案**：[`05-session-more-menu-and-dock-toggle-plan.md`](../05-session-more-menu-and-dock-toggle-plan.md)  
> **审计日期**：2026-10-29  
> **审计结论**：**【通过并附带优化建议（PASS WITH RECOMMENDATIONS）】**

---

## 一、审查目标与核心文件范围

本次审计针对桌面端工作台二叉树右坞抽屉在「空树自动装填概览、点击展开状态机死锁解除、会话标签右坞隔离及测试穿透性」展开源码级与运行时调用链深度核查。

### 涉及的核心文件与职责
1. **`apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx`**：二叉树叶子微内核容器，负责右坞抽屉的折叠/展开入口状态机（`handleToggleDock`）、抽屉挂载门禁（`dockOpen`）与二叉空间树容器（`DockSplitWorkspace`）挂载。
2. **`apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.routing.test.tsx`**：右坞展开状态机防回归单元测试套件。
3. **`apps/crish-desktop/src/store/workspace-shell/openTool.ts`**：工作区 Shell 工具调度器与叶级/会话级右坞代理（`updateLeafDock`、`openToolInLeaf`）。
4. **`apps/crish-desktop/src/store/layout-tree/layoutTreeTransform.ts`**：布局树不可变变换纯函数库（`updateLeafDockInTree`、`updateTabDock`）。
5. **`apps/crish-desktop/src/store/layout-tree/dockLayoutModel.ts`**：右坞二叉树拓扑模型、单例视图判定与纯树算法（`openToolInDock`、`createDefaultDockTree`）。
6. **`apps/crish-desktop/src/store/layout-tree/sessionTabModel.ts`**：会话标签类型系统、`ChatTab.dock` 契约定义与旧状态迁移适配器（`createDefaultDock`）。
7. **`docs/workbench-interaction-repair/05-session-more-menu-and-dock-toggle-plan.md`**：本次修复的设计规划与契约详案。

---

## 二、审计结论总表（Scorecard & Executive Summary）

### 1. 核心维度评审概览

| 审查维度 | 评级 | 结论核心摘要 |
| :--- | :---: | :--- |
| **1. 死锁解除机制** | **PASS** | 准确识别了 `dockOpen` 派生布尔条件硬性依赖 `!isDockTreeEmpty` 的根本死锁点；通过 `createDefaultDockTree` 与 `openToolInDock` 原子化装填 `overview`，数学上保证在空树/null 树/脏数据下 100% 达成 `dockOpen === true`。 |
| **2. 会话标签隔离** | **PASS** | `updateLeafDock` 严格基于 `activeTabId` 路由至 `updateTabDock`，各 `ChatTab.dock` 保持独立二叉树实例，在多会话标签切换时状态完全隔离无串扰。 |
| **3. 工具保留与用户意图** | **PASS** | 展开时通过 `isDockTreeEmpty(currentTree)` 精准区分首开/空树与恢复态；折叠时仅写入 `{ collapsed: true }`，原有 `files` / `terminal` 等工具树拓扑 100% 保留，再次展开无损呈现。 |
| **4. 防回归测试穿透** | **PASS (有建议)** | 测试真实触发了物理按钮的 `fireEvent.click`，测试全绿通过；但存在条件性断言坏味道（`if` 包裹），且未穿透校验装填的视图是否为 `overview` 以及缺少 DOM 抽屉渲染断言。 |

### 2. 缺陷与隐患分级分布

- **【Critical 致命阻断】**：0 项
- **【Major 架构/功能缺陷】**：0 项
- **【Minor 边界/体验隐患】**：2 项
- **【Suggestion 优化建议】**：2 项
- **【Positive 架构肯定项】**：3 项

---

## 三、四大核心审查维度源码级深度剖析

### 维度 1：死锁解除机制（Deadlock Resolution & Tree Auto-Fill）

#### 1.1 原逻辑死锁根因剖析
在 `commit f6ae63f5f` 之前，`TreeLeafPanel.tsx:111-116` 定义的抽屉开闭派生布尔值如下：
```tsx
const dock = activeTab?.dock ?? leaf.dock ?? COLLAPSED_DOCK;
const isTerminalTab = activeTab?.kind === 'terminal';
const isBrowserTab = activeTab?.kind === 'browser';
const isStandaloneTab = isTerminalTab || isBrowserTab;
const dockOpen =
  isChatSurface &&
  !isLeafDraft &&
  !isStandaloneTab &&
  dock.collapsed !== true &&
  Boolean(dock.tree && !isDockTreeEmpty(dock.tree)); // 关键约束点
```
而原有的点击展开函数实现为：
```tsx
const handleToggleDock = useCallback(() => {
  if (!isChatSurface || isStandaloneTab) return;
  if (dockOpen) {
    updateLeafDock(leaf.id, { collapsed: true });
    return;
  }
  updateLeafDock(leaf.id, {
    collapsed: false,
  });
}, [dockOpen, isChatSurface, isStandaloneTab, leaf.id]);
```
**死锁逻辑流推演**：
1. 新创建的对话标签其初始 `dock.tree` 由 `createDefaultDockTree()` 创建，内部 `tabs: []` 为单叶空树（`isDockTreeEmpty === true`），且 `dock.collapsed === true`。
2. 此时，`dockOpen` 计算结果为 `false`，右上角按钮显示“展开右侧工具栏”，右坞抽屉不渲染（`render null`）。
3. 用户点击右上角按钮，触发 `handleToggleDock`。
4. 因为 `dockOpen === false`，执行 `updateLeafDock(leaf.id, { collapsed: false })`。
5. 该更新仅仅将 `dock.collapsed` 置为 `false`，但其内部的 `dock.tree` 依然保持空树状态！
6. 下一帧渲染重新计算 `dockOpen`：虽然 `dock.collapsed !== true` 满足，但 `Boolean(dock.tree && !isDockTreeEmpty(dock.tree))` 依然为 `false`！
7. **结果**：`dockOpen` 依然恒等于 `false`！抽屉继续保持隐藏，按钮保持未激活（`data-active="false"`）。用户重复点击无任何界面反馈，状态机陷入不可逆的逻辑死锁！

#### 1.2 新修复逻辑的不变量保证
在 `f6ae63f5f` 中，`handleToggleDock` 重构为：
```tsx
// apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx:223-238
const handleToggleDock = useCallback(() => {
  if (!isChatSurface || isStandaloneTab) return;
  if (dockOpen) {
    updateLeafDock(leaf.id, { collapsed: true });
    return;
  }
  const currentTree = dock.tree ?? createDefaultDockTree();
  if (isDockTreeEmpty(currentTree)) {
    const { tree: nextTree } = openToolInDock(currentTree, {
      viewId: 'overview',
    });
    updateLeafDock(leaf.id, { collapsed: false, tree: nextTree });
  } else {
    updateLeafDock(leaf.id, { collapsed: false });
  }
}, [dockOpen, isChatSurface, isStandaloneTab, leaf.id, dock.tree]);
```
**数学不变量与全分支推演**：
- **分支 A（`dock.tree === null` 或 `undefined`）**：
  `currentTree` 回退至 `createDefaultDockTree()`。`isDockTreeEmpty(currentTree)` 判定为 `true`。调用 `openToolInDock(currentTree, { viewId: 'overview' })`，在根叶子中注入一个单例 `overview` 标签页，并设置 `activeTabId`。生成的 `nextTree` 满足 `collectSpatialLeaves(nextTree.root).some(l => l.tabs.length > 0)`。通过 `updateLeafDock` 写入后，`dock.collapsed === false` 且 `!isDockTreeEmpty(dock.tree) === true`，下一帧 `dockOpen` 100% 翻转为 `true`。
- **分支 B（`dock.tree` 存在但 tabs 全为空的退化树）**：
  `currentTree = dock.tree`，`isDockTreeEmpty` 仍返回 `true`。`openToolInDock` 命中首个可用叶子插入 `overview` 标签，成功将退化树激活自愈。
- **分支 C（`dock.tree` 已包含其他工具标签的非空树）**：
  `isDockTreeEmpty` 返回 `false`，进入 `else` 分支，仅更新 `{ collapsed: false }`，保留树拓扑，`dockOpen` 顺利翻转为 `true`。

```mermaid
stateDiagram-v2
    [*] --> Collapsed_EmptyTree: 初始折叠空态 (collapsed: true, tree: empty)
    
    state Collapsed_EmptyTree {
        note right of Collapsed_EmptyTree
            dockOpen 评估:
            collapsed !== true (F) && !isDockTreeEmpty (F)
            => dockOpen = False
        end note
    }

    Collapsed_EmptyTree --> AutoFill_Overview: 用户点击展开按钮
    
    state AutoFill_Overview {
        note right of AutoFill_Overview
            handleToggleDock 自愈链路:
            1. isDockTreeEmpty(tree) == true
            2. openToolInDock(tree, { viewId: 'overview' })
            3. updateLeafDock({ collapsed: false, tree: nextTree })
        end note
    }

    AutoFill_Overview --> Expanded_Active: 提交至 LayoutTreeStore
    
    state Expanded_Active {
        note right of Expanded_Active
            下一帧渲染 dockOpen 重新计算:
            collapsed !== true (T) && !isDockTreeEmpty (T)
            => dockOpen = True
            => 抽屉平滑挂载展开！
        end note
    }
```

---

### 维度 2：会话标签隔离（Session Tab Isolation）

#### 2.1 双轨 dock 读取与优先级契约
在 `TreeLeafPanel.tsx:107` 中：
```tsx
const dock = activeTab?.dock ?? leaf.dock ?? COLLAPSED_DOCK;
```
与 `store/workspace-shell/openTool.ts:113-118` 的 `readLeafDock` 实现保持了完全对称：
```ts
export function readLeafDock(leaf: LayoutLeaf): RightToolDockState {
  const tab = leaf.activeTabId
    ? leaf.tabs.find((t) => t.tabId === leaf.activeTabId)
    : undefined;
  return createDefaultDock(tab?.dock ?? leaf.dock);
}
```
**读取优先级为**：`activeTab.dock`（当前激活标签专属坞）> `leaf.dock`（叶子级兜底坞）> `COLLAPSED_DOCK`（静态折叠常量）。

#### 2.2 写入路径路由契约（单向向下委托）
在 `layoutTreeTransform.ts:79-94` 中：
```ts
export function updateLeafDock(
  tree: LayoutTree,
  leafId: string,
  patch: Partial<RightToolDockState>
): LayoutTree {
  if (!leafId || !patch) return tree;
  const node = findNodeById(tree.root, leafId);
  if (!node || !isLeaf(node)) return tree;
  const active = node.activeTabId
    ? node.tabs.find((t) => t.tabId === node.activeTabId)
    : undefined;
  if (active) return updateTabDock(tree, active.tabId, patch);
  const nextDock = createDefaultDock({ ...(node.dock ?? {}), ...patch });
  const updated: LayoutLeaf = { ...node, dock: nextDock };
  return { ...tree, root: replaceNode(tree.root, leafId, updated) };
}
```
再审查 `updateTabDock`（`layoutTreeTransform.ts:60-73`）：
```ts
export function updateTabDock(
  tree: LayoutTree,
  tabId: string,
  patch: Partial<RightToolDockState>
): LayoutTree {
  if (!tabId || !patch) return tree;
  const hit = findTabById(tree.root, tabId);
  if (!hit || hit.tab.kind === 'terminal') return tree;
  const nextDock = createDefaultDock({ ...hit.tab.dock, ...patch });
  const nextTab: SessionTab = { ...hit.tab, dock: nextDock } as SessionTab;
  const newTabs = hit.leaf.tabs.map((t) => (t.tabId === tabId ? nextTab : t));
  const updated: LayoutLeaf = { ...hit.leaf, tabs: newTabs };
  return { ...tree, root: replaceNode(tree.root, hit.leaf.id, updated) };
}
```

#### 2.3 多标签隔离实证分析
假设同一叶子中有 `ChatTab 1 (Tab A)` 和 `ChatTab 2 (Tab B)`：
1. **用户激活 Tab A 并展开右坞**：
   - `node.activeTabId === 'tab-a'`；
   - `updateLeafDock` 自动路由至 `updateTabDock(tree, 'tab-a', { collapsed: false, tree: nextTree })`；
   - `hit.leaf.tabs.map` 仅精准替换 `tabId === 'tab-a'` 的元素，Tab B 的对象引用和内部字段完全不变；
   - `leaf.dock` 亦不被修改。
2. **用户在标签栏切换至 Tab B**：
   - `leaf.activeTabId` 变为 `'tab-b'`；
   - `TreeLeafPanel` 重新渲染，`activeTab` 变为 Tab B；
   - `dock` 读出的是 Tab B 自身的 `tab.dock`（初始处于折叠状态）；
   - `dockOpen` 立即重新计算为 `false`，右坞抽屉在 Tab B 界面下自动收起；
   - Tab A 展开的工具树完好保存在 Tab A 的内部状态中。
3. **用户切回 Tab A**：
   - `activeTab` 变回 Tab A，读取其 `dock.collapsed === false` 与包含 `overview` 的树；
   - `dockOpen` 翻转为 `true`，右坞抽屉平滑恢复呈现。
4. **结论**：在正常 `ChatTab` 范畴内，每个会话标签的右坞状态完全独立，**不存在跨标签状态污染或串扰**。

---

### 维度 3：工具保留与用户意图（Tool Retention vs Default View Fallback）

#### 3.1 用户使用过程真实路径追踪
用户在使用过程中常见的核心操作序列：
1. **打开特定工具**：用户在右侧工具栏打开了 `files`（文件管理器）或 `terminal`（终端）。此时 `openToolInLeaf` 调用 `openToolInDock`，在 `dock.tree` 中建立了包含对应工具的窗格与标签。
2. **主动点击收起**：用户点击右上角 `sidebar-right` 按钮收起右侧栏。
   - 触发 `handleToggleDock`：由于当前 `dockOpen === true`，命中第一分支：
     ```tsx
     if (dockOpen) {
       updateLeafDock(leaf.id, { collapsed: true });
       return;
     }
     ```
   - 此处只传递了 `{ collapsed: true }`，并未传入任何 `tree` 参数。
   - `updateTabDock` 执行 `{ ...hit.tab.dock, ...patch }`，原有的 `dock.tree`（包含用户打开的 `files` 和 `terminal`）**完整保留在状态树中，分毫未动**。
3. **用户再次点击展开**：
   - 此时 `dockOpen === false`。
   - 读取 `currentTree = dock.tree`。
   - 执行 `isDockTreeEmpty(currentTree)`：由于树中已有 `files` 或 `terminal` 标签，`isDockTreeEmpty` 准确返回 `false`！
   - 代码进入 `else` 分支：
     ```tsx
     } else {
       updateLeafDock(leaf.id, { collapsed: false });
     }
     ```
   - 仅更新 `{ collapsed: false }`，原有树直接复用！
   - 下一帧 `DockSplitWorkspace` 重新挂载，原汁原味恢复用户之前的多窗格/特定工具布局。
4. **意图尊重结论**：系统**绝不会**在再次展开时盲目重置或覆盖成默认的 `overview`。`overview` 仅在检测到当前为真正空树时作为首开兜底视图注入，完全符合用户交互心理模型。

#### 3.2 标签关闭时的闭环自愈
审查 `apps/crish-desktop/src/components/binary-tree/DockSplitWorkspace.tsx:179-183`：
```tsx
const patch: { collapsed?: boolean; tree?: DockTree } = {
  tree: nextTree,
  ...(isDockTreeEmpty(nextTree) ? { collapsed: true } : {}),
};
commitDock(patch);
```
当用户在右坞内手动逐一关闭标签页直至最后一个标签时：
- `isDockTreeEmpty(nextTree)` 为 `true`，`DockSplitWorkspace` 自动触发 `{ collapsed: true }` 关闭抽屉；
- 此时右坞变为空树折叠态；
- 随后用户点击右上角展开按钮时，`isDockTreeEmpty` 命中，重新自动注入 `overview`。
- **结论**：整个关闭与展开生命周期逻辑浑然一体，形成无缝闭环。

---

### 维度 4：防回归测试断言穿透与有效性（Test Penetration & Mutation Resilience）

#### 4.1 测试代码审查与真实行为还原
测试用例位于 [`apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.routing.test.tsx:555-597`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.routing.test.tsx#L555-L597)：
```tsx
it('点击展开右侧工具栏按钮时，若 dock 为空树则自动装填 overview 视图并展开', async () => {
  const leaf = makeChatLeaf({
    id: 'dock-toggle-leaf',
    sessionId: 'session-toggle-dock',
    dock: {
      collapsed: true,
      tree: null,
    },
  });
  useLayoutTreeStore.setState({
    activeLeafId: leaf.id,
    tree: { root: leaf, version: 1 },
  });

  render(
    <TreeLeafPanel
      leaf={leaf}
      rect={{ x: 0, y: 0, width: 1, height: 1 }}
      isActive={true}
      isDragSource={false}
    />
  );

  const toggleBtn = await screen.findByRole('button', {
    name: '展开右侧工具栏',
  });
  fireEvent.click(toggleBtn);

  await waitFor(() => {
    const currentLeaf = findNodeById(
      useLayoutTreeStore.getState().tree.root,
      leaf.id
    ) as LayoutLeaf;
    const activeDock =
      currentLeaf?.tabs?.find((t) => t.tabId === currentLeaf.activeTabId)
        ?.dock ?? currentLeaf?.dock;
    expect(activeDock?.collapsed).toBe(false);
    expect(activeDock?.tree).not.toBeNull();
    if (activeDock && activeDock.tree) {
      expect(isDockTreeEmpty(activeDock.tree)).toBe(false);
    }
  });
});
```

#### 4.2 测试实证与穿透性评估
- **真实点击还原度**：测试通过 `screen.findByRole('button', { name: '展开右侧工具栏' })` 寻找到物理按钮，并通过 `fireEvent.click(toggleBtn)` 触发真实 React 合成事件。这证明在初始状态下按钮的语义可访问性名称正确，并且点击事件能够完整穿透到 `handleToggleDock` 回调中，真实反映了用户界面的交互链路。
- **执行表现**：经实测，该测试套件 10 项测试全量通过，耗时约 1.56s。

#### 4.3 存在的脆弱性与断言局限（详见后文隐患表）
1. **条件性断言（Conditional Assertion）**：
   在 `waitFor` 内部使用了 `if (activeDock && activeDock.tree) { expect(isDockTreeEmpty(...)).toBe(false); }`。这是一种在单元测试中应当避免的模式——若因某些异常 `activeDock` 为空，该断言块将被静默跳过，产生潜在的假阳性风险。
2. **未断言注入视图的语义类型（Lack of ViewId Assertion）**：
   测试仅断言了 `isDockTreeEmpty === false`，但没有断言该树中装填的具体标签是否为 `viewId: 'overview'`。若代码误填入其他标签（如 `files`），该测试仍会误判为绿灯。
3. **缺少 DOM 呈现断言（Lack of DOM Visibility Assertion）**：
   测试断言止步于 Store 状态（`LayoutTreeStore`），未进一步验证右坞容器 DOM 节点（如 `[data-leaf-dock-drawer="true"]`）是否成功挂载，以及按钮自身 `data-active` 属性是否翻转为 `'true'`。
4. **缺少再次点击收起的闭环测试**：
   未覆盖“展开后再点一次收起、再点一次恢复旧视图”的完整状态机闭环测试。

---

## 四、问题与潜在隐患详表（Defects & Observations）

### 1. 【Minor 边界隐患】`updateTabDock` 缺少对 `StandaloneBrowserTab` 的类型过滤守卫
- **源码定位**：[`apps/crish-desktop/src/store/layout-tree/layoutTreeTransform.ts:66-67`](file:///c:/Software/conex/apps/crish-desktop/src/store/layout-tree/layoutTreeTransform.ts#L66-L67)
- **代码现场**：
  ```ts
  export function updateTabDock(
    tree: LayoutTree,
    tabId: string,
    patch: Partial<RightToolDockState>
  ): LayoutTree {
    if (!tabId || !patch) return tree;
    const hit = findTabById(tree.root, tabId);
    if (!hit || hit.tab.kind === 'terminal') return tree; // 漏掉了 'browser'
    const nextDock = createDefaultDock({ ...hit.tab.dock, ...patch });
    const nextTab: SessionTab = { ...hit.tab, dock: nextDock } as SessionTab;
  ```
- **深度分析**：
  在 `sessionTabModel.ts:186-192` 中明确定义了：
  ```ts
  export interface StandaloneBrowserTab extends BaseSessionTab {
    readonly kind: 'browser';
    readonly isStandalone: true;
    readonly url: string;
    readonly dock?: never; // 绝不允许挂载右坞！
  }
  ```
  `updateTabDock` 作为不可变数据变换层纯函数，只对 `hit.tab.kind === 'terminal'` 做了跳过保护，却遗漏了 `hit.tab.kind === 'browser'`。虽然上层 `TreeLeafPanel` 的 `handleToggleDock` 使用了 `isStandaloneTab` 做前置拦截，但如果底层纯函数被其他 API 误调，会导致 `StandaloneBrowserTab` 被强行挂载 `dock` 属性，破坏 TypeScript `dock?: never` 的类型不变量。
- **修复建议**：
  ```diff
  - if (!hit || hit.tab.kind === 'terminal') return tree;
  + if (!hit || hit.tab.kind === 'terminal' || hit.tab.kind === 'browser') return tree;
  ```

---

### 2. 【Minor 体验隐患】`useTreePanelEvents.ts` 的快捷键折叠判断与 UI 真实可视状态存在语义漂移
- **源码定位**：[`apps/crish-desktop/src/hooks/useTreePanelEvents.ts:70-75`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/useTreePanelEvents.ts#L70-L75)
- **代码现场**：
  ```ts
  const dock = readLeafDock(node);
  const nextCollapsed = !dock.collapsed;
  if (nextCollapsed) {
    updateLeafDock(targetLeafId, { collapsed: true });
    return;
  }
  if (isDockTreeEmpty(dock.tree)) {
    const { tree: nextTree } = openToolInDock(dock.tree, {
      viewId: 'overview',
    });
    updateLeafDock(targetLeafId, { collapsed: false, tree: nextTree });
  } else {
    updateLeafDock(targetLeafId, { collapsed: false });
  }
  ```
- **深度分析**：
  在 `TreeLeafPanel.tsx:225` 中，判定是否收起是基于视觉真实状态 `if (dockOpen)`。
  但在 `useTreePanelEvents.ts` 中，快捷键事件依然采用旧口径 `const nextCollapsed = !dock.collapsed`。
  当某个会话处于脏状态（例如 `dock.collapsed === false`，但所有工具标签已被关闭导致 `isDockTreeEmpty === true`），此时前端 UI 并未渲染抽屉（用户肉眼看到的是收起状态），用户若按下快捷键触发 `toggle-right-panel`：
  `nextCollapsed` 被评估为 `true`，系统执行了 `updateLeafDock(..., { collapsed: true })`。
  **表现现象**：用户按下快捷键后界面毫无反应（右坞依然不展开），必须再次按下快捷键，才能触发 `nextCollapsed = false` 并注入 `overview` 展开。
- **修复建议**：
  在 `useTreePanelEvents.ts` 中，将折叠判断对齐真实可视状态：
  ```diff
  - const nextCollapsed = !dock.collapsed;
  + const isVisualOpen = !dock.collapsed && Boolean(dock.tree && !isDockTreeEmpty(dock.tree));
  + if (isVisualOpen) {
  +   updateLeafDock(targetLeafId, { collapsed: true });
  +   return;
  + }
  ```

---

### 3. 【Suggestion 优化建议】防回归测试中存在条件性断言与深层语义断言缺失
- **源码定位**：[`apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.routing.test.tsx:593-595`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.routing.test.tsx#L593-L595)
- **分析与建议**：
  建议将测试用例中的条件性断言消除，并补全具体 `overview` 视图与反向折叠测试：
  ```tsx
  // 改进断言建议：
  expect(activeDock).toBeDefined();
  expect(activeDock!.collapsed).toBe(false);
  expect(activeDock!.tree).toBeDefined();
  expect(isDockTreeEmpty(activeDock!.tree!)).toBe(false);
  
  // 语义穿透：断言确实包含 overview
  const tabs = collectDockTabs(activeDock!.tree!);
  expect(tabs.some((t) => t.viewId === 'overview')).toBe(true);

  // 补齐反向折叠测试：再次点击应平滑收起且保留 overview
  fireEvent.click(toggleBtn);
  await waitFor(() => {
    const closedLeaf = findNodeById(useLayoutTreeStore.getState().tree.root, leaf.id) as LayoutLeaf;
    const closedDock = closedLeaf?.tabs?.[0]?.dock;
    expect(closedDock?.collapsed).toBe(true);
    // 核心保证：收起时不丢树！
    expect(isDockTreeEmpty(closedDock!.tree!)).toBe(false);
  });
  ```

---

### 4. 【Suggestion 优化建议】叶级瞬态最大化状态 `isMaximized` 在多 Tab 切换时的重置与作用域考量
- **源码定位**：[`apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx:118-124`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx#L118-L124)
- **分析与建议**：
  `isMaximized` 是保存在 `TreeLeafPanel` 的局部组件状态（`useState(false)`）。当用户在 Tab A 中将右侧栏全屏最大化，若 Tab B 处于折叠状态，切到 Tab B 会触发 `useEffect` 将 `isMaximized` 置为 `false`。切回 Tab A 时，Tab A 的最大化状态丢失。
  虽然这符合多数多文档桌面应用“折叠后重置最大化”的默认心理预期，但若后续需要追求极致的会话工作台隔离体验，可考虑将 `isMaximized` 放入 `RightToolDockState` 统一做 Tab 级持久化。

---

## 五、架构亮点与肯定项（Positives）

1. **精准解耦，拒绝打补丁与延时盲猜（No Patch, Zero-Timer）**：
   修复方案没有引入 `setTimeout`、`requestAnimationFrame` 或额外的全局脏标志，而是精准击中 `dockOpen` 派生布尔状态机的定义盲区，在用户触发意图的一瞬间通过纯函数 `openToolInDock` 完成状态自愈，保持了 O(1) 的纯度。
2. **完好保留用户现场意图（Preserve User Context）**：
   在展开分支中通过 `isDockTreeEmpty(currentTree)` 严格分流，只在纯空树时注入 `overview`；对于已包含工作区标签的会话，再次展开时 100% 保持原有二叉分屏拓扑，杜绝了“一展开就重置”的粗暴重置破坏。
3. **代码变更极简克制（Minimal Blast Radius）**：
   在 `TreeLeafPanel.tsx` 中核心变更仅约 10 行，直接复用既有的 `dockLayoutModel` 纯函数生态，既未增加外部组件耦合，也未引起渲染性能衰减。

---

## 六、最终审计结论

**本次二叉树右坞工具栏展开、空树自动补全与状态机死锁解开改动（commit `f6ae63f5f`）在架构设计、状态机严密性、多会话隔离及意图保留上均表现优秀，已彻底解除空树展开死锁故障，准予上线交付。**  
报告中指出的 2 处 Minor 隐患（`updateTabDock` 对 BrowserTab 的守卫拦截、`useTreePanelEvents` 快捷键判断同步）及 1 处测试断言加强建议，可列入后续工作台交互的日常代码卫生（Chore/Refactor）迭代中顺手收口。
