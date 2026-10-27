# 专项审计报告 B：DockLayoutTree 数据模型正确性与向后兼容性深度审计

> **审计案卷**：`docs/dock-split-system/plan-reviews/审计B-数据模型与兼容性.md`  
> **审计对象**：`docs/dock-split-system/00-总方案.md` §3.1 及 `docs/dock-split-system/analysis/01-分屏引擎模型与数据契约下沉.md`  
> **审计角色**：数据模型正确性与向后兼容性专项审计师  
> **代码基线**：`apps/crish-desktop/src/store/layout-tree/`、`apps/crish-desktop/src/store/workspace-shell/`、`apps/crish-desktop/src/components/binary-tree/`  
> **遵循法则**：仓库根目录 `AGENTS.md`、`.agents/LOGIC_PLAN_NO_RETREAT.md`、反过度设计红线、立体化验证纪律 §7.1  

---

## 一、审计执行摘要与总体裁决

本审计针对"右侧功能区分屏系统"中核心状态树模型 `DockLayoutTree` 的契约设计、持久化兼容性、投影同步机制及退化态边界进行了白盒穿透核查。

实地核查表明：方案 01 提出的轻量化纯逻辑二叉树抽象方向正确，成功将右侧功能区与外层繁重的会话/草稿树进行了逻辑解耦。然而，**在状态持久化、读写同步机制、退化空态及几何安全边界上，存在 3 处致命冲突（必须在 Phase 1 编码前纠正）与 2 处潜在设计警告**。

| 审计维度 | 核心核查焦点 | 裁决标签 | 核心风险摘要 |
| :--- | :--- | :---: | :--- |
| **维度 1** | 持久化与序列化安全（LocalStorage 降级/升级） | **[冲突：必须解决]** | 新版升级后若降级至旧版，旧版会保留 `layout` 脏属性；在旧版修改面板后再升至新版，`ensureDockLayoutTree` 将因短路返回陈旧快照而**静默抹杀用户的最新修改**。 |
| **维度 2** | 类型守卫与运行时安全（SSOT 投影双向同步） | **[冲突：必须解决]** | 代码库中至少存在 8 处直接读写 `openPanelIds` 与 `activePanelId` 的存量路径；方案中的 `syncDockStateWithTree` 仅停留在文档描述层面，缺乏底层强一致写网关阻断，极易引发状态撕裂。 |
| **维度 3** | 空树与退化态安全（右坞无工具时的行为与视觉） | **[冲突：必须解决]** | 方案在空叶树时字段类型不一（`null` vs `''`）；若 `activePanelId` 残留非空，`dockOpen` 判定为 `true` 却渲染空窗格，触发全屏灰色空白块与空 Tab 栏的视觉灾难。 |
| **维度 4** | `splitRatio` 边界与几何正确性 | **[警告：可接受但需澄清]** | 方案将范围设为 `[0.1, 0.9]`，但在右坞 300px 宽度下，0.1 占比导致窗格仅 30px 宽，xterm/文件树/TabStrip 必定崩溃重叠；缺乏方向敏感性与最小物理像素保护。 |
| **维度 5** | `activeLeafId` 的一致性维护与命名空间 | **[警告：可接受但需澄清]** | 内外层均命名为 `activeLeafId`，语义冲突且在上下文解构时必然导致变量名遮蔽与调试混淆；在空态时类型不自洽（`string` 强制非空无法表达无焦点）。 |

---

## 二、逐维度深度审计与代码白盒证据

---

### 维度 1：持久化与序列化安全

#### 1. 结论标签
**[冲突：必须解决]**

#### 2. 代码现状与实地证据
1. **Zustand `persist` 配置行为**：
   - 文件定位：`apps/crish-desktop/src/store/layout-tree/layoutTreeStore.ts:441-454`
     ```typescript
     {
       name: layoutTreeStorageKey(),
       storage: createJSONStorage(() => localStorage),
       version: 3,
       partialize: (s) => ({
         tree: s.tree,
         activeLeafId: s.activeLeafId,
         toolColumnCollapsed: s.toolColumnCollapsed,
       }),
       onRehydrateStorage: () => (state) => {
         rehydrateLayoutTreeState(state);
       },
     }
     ```
   - 精确判定：`partialize` 完整保留了 `s.tree`；而 `SessionTab.dock` 是挂载在每个叶子 `leaf.tabs[i].dock` 上的普通对象。Zustand 默认使用原生 `JSON.stringify` 序列化，因此 **`SessionTab.dock` 及其内部新增的任何属性（包括 `dock.layout`）会被 100% 完整持久化到 localStorage 的 `crish-layout-tree-v1` 键中**，没有任何字段过滤或剥离机制。

2. **旧版本代码对未知字段 `layout` 的处理逻辑**：
   - 水合调用链路：`layoutTreeHydrateHelpers.ts:87-116` $\rightarrow$ `sessionTabMigration.ts:224-237` $\rightarrow$ `sessionTabModel.ts:300-303`。
   - 文件定位：`apps/crish-desktop/src/store/layout-tree/sessionTabModel.ts:40-44, 300-303`
     ```typescript
     export function createDefaultDock(
       partial?: Partial<RightToolDockState>
     ): RightToolDockState {
       return { ...DEFAULT_RIGHT_DOCK, ...partial };
     }
     // ...
     const dock =
       o.dock && typeof o.dock === 'object'
         ? createDefaultDock(o.dock as Partial<RightToolDockState>)
         : createDefaultDock();
     ```
   - 结构门闩校验：`apps/crish-desktop/src/store/layout-tree/layoutRestorePolicy.ts:37-53`
     ```typescript
     function isSessionTabStructurallyValid(t: unknown): boolean {
       // ...
       const d = o.dock as Record<string, unknown>;
       if (typeof d.collapsed !== 'boolean') return false;
       if (!Array.isArray(d.openPanelIds)) return false;
       if (typeof d.widthRatio !== 'number' || !Number.isFinite(d.widthRatio)) return false;
       if (d.activePanelId !== null && typeof d.activePanelId !== 'string') return false;
       // 无任何对未知属性的拦截断言！
     ```
   - 精确判定：旧版本在水合反序列化时，使用 `{ ...DEFAULT_RIGHT_DOCK, ...partial }` 进行对象扩展展开。因为 `o.dock` 包含 `layout`，扩展运算符会**原封不动地将 `layout` 保留在内存中的 dock 对象内**。同时，`layoutRestorePolicy.ts` 仅按白名单校验已知字段，不禁止多余字段。因此：**旧版本既不会崩溃，也不会报错丢弃 dock，而是静默忽略并保留了 `dock.layout` 属性**。

#### 3. 方案 01 漏洞剖析：降级-修改-升级引发的僵尸数据覆盖
方案 01 §4.2 提出的升水管道代码如下：
```typescript
export function ensureDockLayoutTree(dock?: Partial<RightToolDockState> | null): DockLayoutTree {
  // 1. 如果已存在合法的 layout 且通过结构校验，直接返回深拷贝或原对象
  if (dock?.layout && isValidDockLayoutTree(dock.layout)) {
    return dock.layout; // <--- 致命短路漏洞！
  }
  // 2. 否则，从旧版 openPanelIds 与 activePanelId 无损升水 (Hydrate)
  // ...
}
```
**时序灾难推演**：
1. 用户在具备分屏特性的新版本中打开了面板 `[terminal, diff]`，生成了 `dock.layout` 并写入 localStorage；
2. 用户因为某种原因启动/降级回旧版本软件：旧版本正常启动，保留了内存中的 `dock.layout`；
3. 用户在旧版本中关闭了 `diff`，并新建了 `preview` 面板。此时旧版本的 `openToolInLeaf` 与 `handleCloseToolTab` 只会修改 `dock.openPanelIds = ['terminal', 'preview']` 和 `dock.activePanelId = 'preview'`，**完全不触碰、也不会更新 `dock.layout`**；
4. 用户重新启动新版本软件：`ensureDockLayoutTree` 执行。由于 `dock.layout` 依然存在且结构完全合法，它在步骤 1 **直接返回了陈旧的 `dock.layout`（内部依然是 `[terminal, diff]`）**；
5. **灾难后果**：用户在旧版中打开的 `preview` 面板凭空丢失，已关闭的 `diff` 幽灵复活！旧版的所有操作被陈旧的僵尸树直接静默抹杀。

#### 4. 刚性整改契约
`ensureDockLayoutTree` 必须引入**一致性指纹校验（Consistency Hash / Panel Set Alignment）**，严禁盲目信任 `dock.layout`：
```typescript
export function ensureDockLayoutTree(dock?: Partial<RightToolDockState> | null): DockLayoutTree {
  if (dock?.layout && isValidDockLayoutTree(dock.layout)) {
    // 检查树中包含的面板集合是否与 dock.openPanelIds 完全对齐
    const treePanels = new Set(collectAllDockPanelIds(dock.layout.root));
    const flatPanels = new Set(dock.openPanelIds ?? []);
    const isAligned =
      treePanels.size === flatPanels.size &&
      [...treePanels].every((p) => flatPanels.has(p));

    if (isAligned) {
      return dock.layout;
    }
    // 若脱节，说明在旧版本发生过偏航修改，强制以最新的 flatPanels 重新升水！
  }
  // 回退升水逻辑...
}
```

---

### 维度 2：类型守卫与运行时安全

#### 1. 结论标签
**[冲突：必须解决]**

#### 2. 代码现状与实地证据
方案 01 声称通过 `syncDockStateWithTree` 实现“单一真理源（SSOT）自动投影”，并假设所有业务操作只改 `dock.layout`。但实地静态审计发现，现存代码库中有**至少 8 处直接绕过 `layout` 读写 `dock.openPanelIds` 与 `dock.activePanelId` 的存量核心路径**：

1. `apps/crish-desktop/src/hooks/useTreePanelEvents.ts:70-74`：
   快捷栏切换右侧功能区展开态，直接手动构造补丁写回：
   ```typescript
   patch.activePanelId = 'overview';
   patch.openPanelIds = dock.openPanelIds.length ? dock.openPanelIds : ['overview'];
   ```
2. `apps/crish-desktop/src/hooks/useTreePanelEvents.ts:161-180`：
   键盘快捷键 `Ctrl+1/2` 快速切换上一个/下一个工具面板：直接按索引计算 `targetId`，然后调用 `updateTabDock(activeTabId, { activePanelId: targetId })`，完全不更新 `dock.layout`。
3. `apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx:224`：
   Tab 标签点击选中回调 `handleSelectToolTab`：直接执行 `updateLeafDock(leaf.id, { activePanelId: panelId })`。
4. `apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx:232-237`：
   Tab 关闭回调 `handleCloseToolTab`：直接调用纯扁平函数 `computeNextDockAfterClose`，直接产出并写入 `{ openPanelIds, activePanelId }`。
5. `apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx:248-253`：
   右坞顶部小图标开关抽屉 `handleToggleDock`：直接硬编码写入 `{ activePanelId: dock.activePanelId || 'overview', openPanelIds: ... }`。
6. `apps/crish-desktop/src/store/workspace-shell/openTool.ts:166-174`：
   业务层开工具入口 `openToolInLeaf`：读取 `dock.openPanelIds`，判断包含后直接调用 `updateLeafDock(id, { collapsed: false, openPanelIds, activePanelId: mapped })`。
7. `apps/crish-desktop/src/store/workspace-shell/openTool.ts:349-357`：
   折叠/展开 API `collapseActiveTabRightDock`：直接修改 `activePanelId` 与 `openPanelIds`。
8. `apps/crish-desktop/src/store/layout-tree/layoutTreeTransform.ts:59-72`：
   底层写树操作 `updateTabDock` 实现：
   ```typescript
   const nextDock = createDefaultDock({ ...hit.tab.dock, ...patch });
   const nextTab = { ...hit.tab, dock: nextDock };
   ```
   仅做浅层对象扩展，**没有任何拦截器将传入的 `patch.activePanelId` 或 `patch.openPanelIds` 投影回 `dock.layout`**。

#### 3. 方案 01 漏洞剖析：单向投影断裂与状态撕裂
方案 01 §4.3 中的 `syncDockStateWithTree` 只是一个没有与底层写网关绑定的独立辅助函数（仅画在流程图里）。
- **如果只操作树**：若某个新组件调用了 `updateTabDock(tabId, { layout: nextTree })`，由于 `updateTabDock` 内部只是 `{ ...dock, ...patch }`，外层的 `openPanelIds` 与 `activePanelId` **根本不会自动更新**！依赖外层字段的 `TreeLeafPanel.tsx:118`（`dockOpen` 判定）将读取到旧的 `activePanelId`。
- **如果调用存量接口**：若存量快捷键触发 `updateTabDock(tabId, { activePanelId: 'diff' })`，外层字段变了，但内层 `dock.layout` 里的激活窗格没有任何变化。分屏渲染器读取 `dock.layout` 时，用户看到的焦点与高亮发生严重撕裂。

#### 4. 刚性整改契约
必须在 `apps/crish-desktop/src/store/layout-tree/layoutTreeTransform.ts` 的写入口实施**网关级双向互锁（Bidirectional Invariant Enforcement）**：
1. **树到投影**：若 `patch.layout` 存在，强制执行 `syncDockStateWithTree`，派生 `openPanelIds` 与 `activePanelId` 覆盖写入；
2. **投影到树**：若 `patch` 仅包含 `openPanelIds` 或 `activePanelId` 而缺少 `layout`，必须触发内联自愈：获取当前 `dock.layout`（若无则升水），调用 `activateDockPanel` 或 `openDockPanel` 同步更新内层树，杜绝双轨漂移。

---

### 维度 3：空树与退化态安全

#### 1. 结论标签
**[冲突：必须解决]**

#### 2. 代码现状与实地证据
1. `TreeLeafPanel.tsx:114-118`：
   ```typescript
   const dock = activeTab?.dock ?? leaf.dock ?? COLLAPSED_DOCK;
   const dockOpen =
     isChatSurface &&
     !isLeafDraft &&
     dock.collapsed !== true &&
     Boolean(dock.activePanelId);
   ```
2. `TreeLeafPanel.tsx:270`：
   ```typescript
   const toolPanelId = dock.activePanelId || 'overview';
   ```
3. `TreeLeafPanel.tsx:462-484`：
   ```tsx
   {dock.openPanelIds.length > 0
     ? dock.openPanelIds.map((pid) => { ... })
     : renderToolOutlet(toolPanelId)}
   ```

#### 3. 方案 01 漏洞剖析：空叶定义不一与幽灵窗格
- **类型契约矛盾**：总方案 00 §3.1（第 96 行）规定 `activePanelId: string`（非空），而方案 01 §3.1 规定 `activePanelId: string | null`。若按总方案定义，空叶必须填入空字符串 `""`。
- **视觉崩溃链路**：
  假设用户关闭了最后一个工具，树退化为空叶。
  - **情况 A（`activePanelId` 残留或被误填为非空）**：
    若由于状态同步时未清空 `activePanelId`（或被快捷展开逻辑 `handleToggleDock` 强行补为 `'overview'`），但 `openPanelIds` 为 `[]`；
    此时 `Boolean(dock.activePanelId)` 为 `true`，`dock.collapsed = false`，导致 **`dockOpen === true`**！
    进入渲染后，由于 `dock.openPanelIds.length === 0`，代码击穿进入三元表达式的后半段：`: renderToolOutlet(toolPanelId)`！
    结果：顶部的 `LeafToolTabStrip` 传入空数组 `tabs={[]}`（标签栏彻底空白），下方却强行渲染了一个没有 Tab 承载的悬空面板；
  - **情况 B（分屏容器 `DockSplitWorkspace` 渲染空叶）**：
    若分屏树根节点为 `{ type: 'leaf', panelIds: [], activePanelId: null }`，`flattenDockTree` 会输出一个 `FlatDockLeaf`（矩形占 100%）。
    渲染容器遍历到该叶片时，由于其没有任何工具面板，将渲染为一个**巨大的灰色无内容占位框**，严重破坏用户界面。

#### 4. 刚性整改契约
1. **严格类型收敛**：在 `DockLayoutLeaf` 中严禁使用空字符串，类型锁定为 `activePanelId: string | null`；
2. **空状态双重约束断言**：数学不变量必须规定：
   $$\text{leaf.panelIds.length} = 0 \iff \text{leaf.activePanelId} = \text{null}$$
3. **收起联动硬断言**：当全树面板总数为 0 时，`syncDockStateWithTree` 必须强制注入 `collapsed: true` 与 `activePanelId: null`；
4. **渲染层兜底守卫**：在 `TreeLeafPanel.tsx` 中加固 `dockOpen` 判定：
   ```typescript
   const dockOpen =
     isChatSurface &&
     !isLeafDraft &&
     dock.collapsed !== true &&
     Boolean(dock.activePanelId) &&
     (dock.layout ? hasAnyPanels(dock.layout.root) : dock.openPanelIds.length > 0);
   ```

---

### 维度 4：`splitRatio` 边界与几何正确性

#### 1. 结论标签
**[警告：可接受但需澄清]**

#### 2. 代码现状与实地证据
1. **现有工作区二叉树常数**：
   文件定位：`apps/crish-desktop/src/store/layout-tree/types.ts:114-122`
   ```typescript
   export const MIN_SPLIT_RATIO = 0.12;
   export const MAX_SPLIT_RATIO = 0.88;
   export function clampSplitRatio(ratio: number): number {
     return Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, ratio));
   }
   ```
2. **方案 01 常数设定**：
   方案 01 §3.1（第 103 行）、§5.3（第 656 行）、§5.4（第 675 行）均硬编码为：
   $$\text{splitRatio} \in [0.10, 0.90]$$
3. **右坞物理宽度约束**：
   文件定位：`apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx:204`
   ```typescript
   const px = Math.max(200, Math.min(w * 0.7, (dock.widthRatio || 0.5) * w));
   ```
   右坞的最小物理像素宽度为 `200px`，常规 1080p/2K 屏幕下常见宽度为 `300px ~ 450px`。

#### 3. 几何风险与不可用性分析
方案 01 未对改动常数的合理性给出任何推导与论证。在右坞这一受限空间内，放宽至 `0.1` 会带来严重的可用性灾难：
1. **极端物理尺寸失控**：
   当右坞宽度为 300px 时，若用户进行水平分屏（`direction: 'horizontal'`），`splitRatio = 0.1` 导致左侧窗格物理宽度仅为 **`30px`**（右侧 270px）！
2. **UI 元素毁灭性挤压**：
   - **终端（Terminal / ConPTY）**：等宽字体标准字符单元宽约为 8px。30px 扣除左右内边距（8px）后仅剩 14px，每行只能显示 1 个字符！xterm 的 `fitAddon` 在执行字符矩阵重排时极易触发列数 $\le 0$ 的数学异常，导致 ConPTY 崩溃；
   - **文件树（FilesCard）**：单行包含缩进线、折叠三角形、文件类型图标及名称，30px 连图标都放不下，全部文字被剪切；
   - **窗格头部（Micro TabStrip）**：一个标签包含图标、标题和关闭按钮（至少需 80px），在 30px 下动作按钮（加号、分屏、关闭）完全重叠，用户甚至无法将鼠标点入分割线将其拉回。
3. **方向不对称性**：
   垂直分屏（`vertical`）时，高度通常有 600px~900px，0.1 占比尚有 60px~90px；但水平分屏（`horizontal`）在 0.1 比例下完全不可用。

#### 4. 优化建议与修订方案
- **建议比例收紧**：废弃随意的 `[0.1, 0.9]`，右坞分屏基线建议收紧为 **`[0.20, 0.80]`**（或至少与外层对齐为 `[0.15, 0.85]`）；
- **方向敏感与物理像素双重保护**：
  纯比例算法在计算时，应结合物理像素约束（Pixel Guard）：
  在拖拽反算比例时（`resizeDockBranch`），增加硬约束：任意叶子节点的物理宽度不得低于 `120px`，高度不得低于 `80px`。若低于阈值，Sash 拖拽拒绝前移。

---

### 维度 5：`activeLeafId` 的一致性维护

#### 1. 结论标签
**[警告：可接受但需澄清]**

#### 2. 代码现状与实地证据
1. **外层工作区树焦点定义**：
   文件定位：`apps/crish-desktop/src/store/layout-tree/layoutTreeStoreTypes.ts:16`
   ```typescript
   export interface LayoutTreeStoreState {
     tree: LayoutTree;
     activeLeafId: string | null; // 代表外层主会话分屏叶片（LayoutLeaf.id）
     // ...
   }
   ```
2. **方案 01 内层分屏树焦点定义**：
   方案 01 §3.1（第 189 行）：
   ```typescript
   export interface DockLayoutTree {
     root: DockLayoutNode;
     activeLeafId: string; // 代表内层右坞工具窗格叶片（DockLayoutLeaf.id）
     version: 1;
   }
   ```

#### 3. 架构隐患剖析
1. **命名碰撞与作用域遮蔽（Variable Shadowing）**：
   在 `TreeLeafPanel.tsx` 及相关分屏管理组件中，通常需要同时消费外层会话叶和内层工具叶。若内外层字段完全同名（同为 `activeLeafId`）：
   ```typescript
   // 开发者极易发生混淆与遮蔽
   const activeLeafId = useLayoutTreeStore((s) => s.activeLeafId); // 外层会话叶 ID
   const { activeLeafId } = dock.layout; // 内层工具叶 ID，造成同名冲突！
   ```
   在日志上报、调试排查及状态快照比对时，同名字段使得无法直接判断焦点位于外层还是内层。
2. **状态语义与类型不对称**：
   - 外层 `activeLeafId` 明确为 `string | null`，因为当工作区处于极端重置状态时允许无焦点；
   - 方案 01 将内层定义为强类型的 `string`（非空），但在右坞无任何工具打开（空树退化）时，该字段被迫填充空字符串 `""` 或一个捏造的 `'dock-leaf-primary'`，破坏了类型的真实性。

#### 4. 优化建议
将内层分屏树的焦点字段明确重命名为 **`activeDockLeafId`**（或 **`focusedPaneId`**），并将类型调整为可空的 `string | null`：
```typescript
export interface DockLayoutTree {
  root: DockLayoutNode;
  /** 当前处于焦点状态的右坞窗格 ID；若右坞无工具则为 null */
  activeDockLeafId: string | null;
  version: 1;
}
```
此改动彻底消除了变量遮蔽隐患，且在多层嵌套环境中保持语义自解释。

---

## 三、最终审计结论与整改行动清单（Phase 1 门禁）

根据上述白盒审计，`DockLayoutTree` 方案原则上通过架构审查，但必须在进入代码实现（Phase 1）前将以下 5 条整改项纳入执行规范：

1. **[必须解决] 升水指纹对齐**：在 `ensureDockLayoutTree` 中增加对 `openPanelIds` 与树中全量叶片面板的集合对称性校验，检测到旧版本脱节修改时强制重新水合，解决降级后再升级的僵尸覆盖问题。
2. **[必须解决] 写网关双向强一致**：改造 `layoutTreeTransform.ts` 中的 `updateTabDock` 与 `updateLeafDock`，将其作为单一写网关，当接收到外层 `patch` 或内层 `layout` 时自动双向对齐，消除存量 8 处调用导致的状态撕裂。
3. **[必须解决] 空叶严谨定义**：统一 `DockLayoutLeaf.activePanelId` 为 `string | null`，并在树清空时硬断言 `activePanelId: null` 与 `collapsed: true`，加固 `dockOpen` 判定防止渲染空白幽灵窗格。
4. **[建议澄清] 几何安全收紧**：将 `splitRatio` 范围收紧为 `[0.2, 0.8]`，并在渲染拖拽层加入最小物理像素阻断（宽 $\ge 120\text{px}$，高 $\ge 80\text{px}$），杜绝 30px 不可用极端窗格。
5. **[建议澄清] 消除同名遮蔽**：将内层字段 `activeLeafId` 改为 `activeDockLeafId: string | null`，提升代码可读性与类型严谨度。

本案卷作为战役 Phase 1 数据模型建设与单测编写的刚性核查依据！
