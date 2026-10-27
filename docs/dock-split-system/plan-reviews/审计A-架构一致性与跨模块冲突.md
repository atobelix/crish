# 架构审计报告 A：分屏系统架构一致性与跨模块冲突深度审查

> **审计标的**：
> - `docs/dock-split-system/00-总方案.md`
> - `docs/dock-split-system/analysis/01-分屏引擎模型与数据契约下沉.md`
> - `docs/dock-split-system/analysis/02-右坞容器与分屏渲染架构.md`
> - `docs/dock-split-system/analysis/03-顶栏大窗口收敛与独立常规终端.md`
> - `docs/dock-split-system/analysis/04-拖拽体系与域隔离防线.md`
> 
> **审计角色**：严苛架构审计师  
> **审计依据**：仓库代码实地白盒核查、通用协作纪律 `AGENTS.md`、反退避全文 `.agents/LOGIC_PLAN_NO_RETREAT.md`、反过度设计红线 `ANTI_OVERENGINEERING_GUARDRAILS.md`。  
> **审计结论总览**：发现 **4 处架构冲突（必须阻断解决）** 与 **2 处严重概念漂移/遗漏警告（需强制修正补齐）**。方案目前各子模块之间存在明显的“各自为战”断层，严禁在未消解冲突前直接进入代码实施阶段。

---

## 维度 1：接口契约一致性

### 审计结论：【冲突：必须解决】

### 1.1 方案 00、01 与 02 之间树节点结构及字段命名严重漂移

在跨模块审查中，发现方案 00、方案 01 与方案 02 对分屏树的核心数据契约存在三份互不兼容的定义，甚至在同一概念上出现了命名割裂：

1. **叶子节点类型与字段分裂**：
   - **方案 00 §3.1 (`00-总方案.md:92-97`)**：
     ```typescript
     export interface DockLayoutLeaf {
       type: 'leaf';
       id: string;
       panelIds: string[];
       activePanelId: string; // ⚠️ 必填 string，不允许为 null
     }
     ```
   - **方案 01 §3.1 (`01-分屏引擎模型与数据契约下沉.md:152-163`)**：
     ```typescript
     export interface DockLayoutLeaf {
       type: 'leaf';
       id: string;
       panelIds: string[];
       activePanelId: string | null; // ⚠️ 允许 null（当窗格内标签清空时）
     }
     ```
   - **方案 02 §3.2 (`02-右坞容器与分屏渲染架构.md:248-253`)** 出现严重命名漂移：
     ```typescript
     export interface DockLeafNode { // ⚠️ 命名变为 DockLeafNode，而非 DockLayoutLeaf
       type: 'dock-leaf';           // ⚠️ type 字面量变为 'dock-leaf'，而非 'leaf'
       id: string;
       tabs: string[];              // ⚠️ 字段名变为 tabs，而非 panelIds
       activeTabId: string;         // ⚠️ 字段名变为 activeTabId，而非 activePanelId
     }
     ```

2. **分支节点与整树容器定义分裂**：
   - 方案 00/01 约定分支为 `DockLayoutBranch`（`type: 'branch'`），整树为 `DockLayoutTree`，包含 `root: DockLayoutNode`、`activeLeafId: string`、`version: 1`。
   - 方案 02 §3.2 (`02-右坞容器与分屏渲染架构.md:255-270`) 却将其私自改为 `DockBranchNode`（`type: 'dock-branch'`），并且其定义的 `DockLayoutTree` **完全遗漏了 `activeLeafId` 字段**（仅包含 `root` 与 `version: number`）。
   - 方案 02 §3.4 图表 (`02-右坞容器与分屏渲染架构.md:423-424`) 中，`RightToolDockState` 挂载的字段被命名为 `dockTree: DockLayoutTree` 和 `activePaneId: string`；而在方案 00 §3.1 与方案 01 §4.1 (`01-分屏引擎模型与数据契约下沉.md:382`) 中，权威字段命名明确是 `layout?: DockLayoutTree`。

### 1.2 `flattenDockTree` 几何展平函数签名与类型互不兼容

方案 01 与方案 02 的 `flattenDockTree` 无论入参、返回值还是内部产物均无法对接：

- **方案 01 §5.2 (`01-分屏引擎模型与数据契约下沉.md:576-639`)**：
  ```typescript
  export function flattenDockTree(tree: DockLayoutTree): FlattenedDockLayout
  ```
  - **入参**：整树 `tree: DockLayoutTree`（以此读取 `tree.activeLeafId` 计算 `isActive`）。
  - **输出**：`leaves: FlatDockLeaf[]`（包含 `leafId`, `panelIds`, `activePanelId`, `rect`, `isActive`）与 `branches: FlatDockBranch[]`（包含精确的 `sash: { x, y, length, direction }` 几何线段）。
- **方案 02 §3.2 (`02-右坞容器与分屏渲染架构.md:291-333`)**：
  ```typescript
  export function flattenDockTree(root: DockNode): {
    panes: FlatDockPane[];
    sashes: FlatDockSash[];
  }
  ```
  - **入参**：单根节点 `root: DockNode`。
  - **输出**：`panes: FlatDockPane[]`（字段是 `paneId`, `tabs`, `activeTabId`，**没有 `isActive`**）与 `sashes: FlatDockSash[]`（**缺失 sash 物理线段几何属性**）。

**裁决要求**：必须以方案 01 的数学模型为唯一定义（SSOT），全面废除方案 02 §3.2 的私有伪类型；方案 02 的渲染层必须无条件对齐方案 01 的 `DockLayoutTree`、`DockLayoutLeaf`、`DockLayoutBranch` 以及 `FlatDockLeaf` / `FlatDockBranch`。

---

## 维度 2：渲染与数据同步冲突

### 审计结论：【冲突：必须解决】

### 2.1 右坞容器替换边界与 DOM 假设错误

方案 00 §3.2 (`00-总方案.md:124-125`) 声称：
> “在 `TreeLeafPanel.tsx` 的 `leafDockDrawer` 内部，移除原本单一的 `leafDockOutlet`，挂载 `DockSplitWorkspace`”

**实地源码核查证据**：
查阅 `apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx:433-486`，代码中**根本不存在**名为 `leafDockOutlet` 的容器！
现有的右坞 DOM 结构是：
```tsx
// TreeLeafPanel.tsx:433-486
<div className={`${styles.leafDockDrawer} ... chat-side-panel`}>
  <LeafToolTabStrip ... />
  <AppErrorBoundary ...>
    <Suspense ...>
      {dock.openPanelIds.length > 0
        ? dock.openPanelIds.map((pid) => (
            <div key={pid} className={styles.dockPanelPane} style={{ display: isPanelActive ? 'flex' : 'none' }}>
              {renderToolOutlet(pid)}
            </div>
          ))
        : renderToolOutlet(toolPanelId)}
    </Suspense>
  </AppErrorBoundary>
</div>
```

**冲突点分析**：
1. **替换边界模糊**：方案 02 未明确说明 `DockSplitWorkspace` 是连同现有的 `<LeafToolTabStrip>` 一起替换，还是仅替换 `<AppErrorBoundary>` 下的卡片堆叠区域。
2. **多层最大化状态覆盖死锁**：方案 02 §3.5 提出了“窗格单开最大化”，方案 02 §4.2 又提出拖拽 Live Resize 期间“绝不触发 React 重渲染，DOM 直写 `left/top/width/height %`”。然而在单窗格最大化时，若该窗格直接通过 React 样式或 class 变为 `inset: 0; width: 100%; height: 100%`，用户一旦在未退出最大化前触发了外层 resize 或误触 Sash，DOM 直写逻辑会立刻以旧的百分比比例覆盖内联 style，导致最大化瞬间被击穿撕裂。方案未设计直写 style 在最大化模式下的门禁守卫。

### 2.2 外层 `LeafDockResizer` 与内层 `DockSplitSash` 的状态机与命中冲突

方案 02 §4.1 虽然给出了三类分割线的职责对比表，但在工程实践层面遗漏了关键的交互物理冲突：

1. **全局类名混淆（Classname Chaos）**：
   - 现存 `LeafDockResizer.tsx:40, 68` 拖拽时往 `document.body` 挂载 `leaf-dock-resizing`；
   - 方案 02 §3.3 (`02-右坞容器与分屏渲染架构.md:355`) 检查的是 `document.body.classList.contains('dock-resizing')`；
   - 方案 02 §5.4 (`02-右坞容器与分屏渲染架构.md:758-761`) 又写为 `:global(.leaf-dock-resizing)`；
   - 方案 04 §3.3 & §7.2 拖拽时挂载的又是 `is-dock-dragging`。
   三套类名在各个文档间交织使用，未统一冻结状态标志。
2. **边缘 Sash 物理命中碰撞（Sash Collision）**：
   外层 `LeafDockResizer` 紧贴 `leafDockDrawer` 的左外侧边缘（拥有 `12px` 的隐式热区扩展 `::after`）。若右坞分屏树最左侧存在垂直分割线，当分割线靠近左边界（比例接近 `0.1`）时，两个 Resizer 的指针捕获热区将发生重叠，极易导致用户本意调整内部分屏比例，却触发了外层整个右坞宽度的伸缩。方案完全未对内层 Sash 设置与外边缘的物理防死区（Deadzone Buffer）。

---

## 维度 3：顶栏独立终端与现有 TreeLeafPanel 的渲染路径冲突

### 审计结论：【冲突：必须解决】

### 3.1 独立终端未与 `TreeLeafPanel.tsx` 的右坞控制按钮完全切断

方案 03 §3.1 (`03-顶栏大窗口收敛与独立常规终端.md:322-324`) 确立了铁律：
> “纯终端全景界面（Drawer-Free Full Surface）：独立常规终端大窗口**永久不显示右侧功能区抽屉**（`dockOpen` 永久为 `false`）”

并在方案 03 §7 阶段二中声称：
> “隐藏顶部的 Chrome 操作按钮（`UnitChromeActions`）”

**实地代码核查揭露严重遗漏**：
查阅 `apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx:490-502`：
```tsx
{isChatSurface && !isLeafDraft && (
  <Button
    type="button"
    variant="ghost"
    className={`${styles.topSidePanelBtn} top-action-btn top-side-panel-btn`}
    data-testid="top-quick-dock-btn"
    data-active={dockOpen ? 'true' : 'false'}
    aria-label={dockOpen ? '收起右侧工具栏' : '展开右侧工具栏'}
    onClick={handleToggleDock}
  >
    <AppIcon name="sidebar-right" size={16} aria-hidden />
  </Button>
)}
```
同时查看 `TreeLeafPanel.tsx:83-84`：
```typescript
const chatMainSurface = useLayoutStore((s) => s.chatMainSurface) ?? 'chat';
const isChatSurface = chatMainSurface === 'chat';
```

**冲突事实**：
1. `isChatSurface` 仅仅是全局布局的一个配置项（默认值就是 `'chat'`），它**完全不检查当前激活标签是否为 `terminal`**！
2. 即使当前激活的是 `StandaloneTerminalTab`，由于 `isChatSurface === true` 且 `!isLeafDraft`，**右上角的 `topSidePanelBtn`（展开/收起右侧工具栏按钮）依然会被强行渲染在终端界面的右上角！**
3. 用户一旦点击此按钮，`handleToggleDock`（`TreeLeafPanel.tsx:248-253`）将强行调用 `updateLeafDock(leaf.id, { collapsed: false, ... })`，直接在独立常规终端右侧重新唤醒右坞抽屉，彻底撕毁“纯终端全景界面”的铁律！
4. 方案 03 只记住了隐藏聊天视口内部的 `UnitChromeActions`，却**完全遗漏了 `TreeLeafPanel.tsx` 顶层绝对定位的 `topSidePanelBtn`**。

### 3.2 独立终端在 `ViewRenderContext` 上的上下文污染

在 `TreeLeafPanel.tsx:107-112`：
```typescript
const fallbackSessionId = resolveLeafSessionId(leaf, {
  isFocused: isActive,
  globalActiveSessionId,
});
const effectiveSessionId = tabResolution.sessionId ?? fallbackSessionId;
```
若 `activeTab` 为 `StandaloneTerminalTab`，其 `sessionId` 明确为 `undefined`。由于 `tabResolution.sessionId` 为 `null/undefined`，代码会无条件走入 `fallbackSessionId`，导致独立终端被强行注入当前全局激活的 Chat 会话 ID（`globalActiveSessionId`），进而在底层 `TerminalCard` 中通过 `useScopedSessionId` 错误关联到聊天会话。方案 03 仅给出了数据模型，完全未给出在 `TreeLeafPanel.tsx` 构建 `mainCtx` 时对 `isStandalone` 的防御分叉逻辑。

---

## 维度 4：跨域隔离与现有拖拽 Hook 的实际接口

### 审计结论：【冲突：必须解决】

### 4.1 方案 04 的“顶栏 DOM 门锁”机制存在原生物理无效性（致命技术硬伤）

方案 04 §7.3 (`04-拖拽体系与域隔离防线.md:666-688`) 提出了如下“防线 2 门锁”：
```tsx
// 方案 04 建议在 PaneHeader.tsx 的 tabsContainer 上增加：
onPointerEnter={(e) => {
  if (document.body.getAttribute('data-drag-domain') === 'dock-tool') {
    e.preventDefault();
    e.stopPropagation();
  }
}}
onPointerMove={(e) => {
  if (document.body.getAttribute('data-drag-domain') === 'dock-tool') {
    e.preventDefault();
    e.stopPropagation();
  }
}}
```

**白盒原理穿透审计**：
1. **Pointer Capture 机制下的事件重定向**：
   方案 04 §5.1 (`04-拖拽体系与域隔离防线.md:424-432`) 与 §7.2 (`04-拖拽体系与域隔离防线.md:574-576`) 明确声明：右坞拖拽启动时**必须**调用 `e.currentTarget.setPointerCapture(pointerId)`。
   根据 W3C Pointer Events 规范，一旦元素获取了指针捕获，**后续所有的 pointermove、pointerenter、pointerover 事件全部强制分发给源捕获元素，任何悬停的目标元素（Hover Targets）根本不会触发原生 `pointerenter` 或 `pointermove`！**
2. **逻辑形同虚设**：
   在指针捕获期间，顶栏 `tabsContainer` 上绑定的 `onPointerEnter` 和 `onPointerMove` **彻底失去被调用的物理可能**！方案 04 提出的门锁代码完全是无效的伪代码，根本无法起到阻断作用。
3. **真实逃逸路径**：
   目前顶栏标签落点判定（`SessionTabDragContext.tsx:252`）根本不是靠 DOM 上的 `onPointerMove`，而是靠在全局 `window` 监听器中主动调用 **`document.elementFromPoint(p.x, p.y)`**。方案 04 试图用目标 DOM 上的 `stopPropagation` 阻挡全局 `elementFromPoint`，在浏览器运行机制上是完全错误的。

### 4.2 现有拖拽接口现状澄清与并发互斥盲区

1. **`useTreeDrag.ts` 真实代码现状**：
   实地查阅 `apps/crish-desktop/src/hooks/useTreeDrag.ts:1-70`，该 Hook 已经在历史“维 06”重构中被**完全掏空为空操作（no-op）**，其返回的 `draggedSource: null`, `activeDropZone: null` 均为静态占位符。方案若试图在 `useTreeDrag` 中做状态共享属于刻舟求剑。
2. **全局 DOM 标志竞争隐患**：
   `SessionTabDragContext.tsx` 依赖 `document.body.classList.add('is-tab-dragging')`，而方案 04 的 `DockToolDragContext.tsx` 依赖 `document.body.setAttribute('data-drag-domain', 'dock-tool')`。
   若发生多指针触控或异常时序（前一个拖拽触发 `window.blur` 尚未排空，用户瞬间在另一区域按下鼠标），全局属性会被瞬间相互践踏，导致单例状态混乱。必须建立互斥锁（Mutex）确保任意时刻全局只允许一个激活的拖拽域。

---

## 维度 5：遗漏覆盖区域

### 审计结论：【警告：可接受但需澄清】

### 5.1 `LeafToolTabStrip.tsx` 存量资产处置方案严重分裂

查阅 `apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx`，该文件拥有 **454 行** 严密的业务逻辑，集成了：
- `SidePanelLauncherHub`（右坞工具全局启动面板）
- `SidePanelNavToolbar`（专用于 Webview 浏览器的后退/前进/刷新工具条，`LeafToolTabStrip.tsx:23`）
- `useNonPassiveWheel`（水平滚轮滑动）
- `useTablistKeyboard`（TabList 键盘无障碍漫游）

**各方案对其处置互相矛盾**：
- **方案 01 §6.2 (`01-分屏引擎模型与数据契约下沉.md:703`)**：提出“改造为支持传递 `leafId`，标签选中/关闭/分屏操作作用于所属的具体窗格”。
- **方案 02 §6.1 (`02-右坞容器与分屏渲染架构.md:796`)**：提出“移除原本平铺的 `LeafToolTabStrip`……将其替换为 `<DockSplitWorkspace ... />`”，并在内部新建独立的 `DockPaneHeader`。
- **方案 00 §3.6 (`00-总方案.md:206-208`)**：提出“单工具时退化为现有 `LeafToolTabStrip`，多分屏时每个窗格拥有独立的 `MicroPaneTabStrip`”。
- **方案 04 §7.1 (`04-拖拽体系与域隔离防线.md:525`)**：又把 `LeafToolTabStrip.tsx` 列为改动接入点。

**漏洞影响**：
如果按方案 02 直接移除 `LeafToolTabStrip`，那么 `SidePanelNavToolbar`（浏览器专属导航控制）与 `SidePanelLauncherHub` 的存量资产将被直接丢弃；如果按方案 00 搞“两套 TabStrip 动态退化”，则会引入大量重复代码与组件生命周期重挂载抖动（违反 `ANTI_OVERENGINEERING_GUARDRAILS.md`）。必须给出明确统一的收敛裁决。

### 5.2 对话顶部 `UnitChromeActions.tsx` 在分屏下的联动完全遗漏

查阅 `apps/crish-desktop/src/components/chat-card/UnitChromeActions.tsx:109-112, 322-352`：
```typescript
const isPreviewActive = dockOpen && dockPanelId === 'preview';
const isArtifactsActive = dockOpen && dockPanelId === 'files';
```
顶部快捷按钮（浏览器、文件树）依赖 `dockPanelId === 'preview'` 判断高亮态。

**方案遗漏事实**：
1. **高亮失真**：当右坞进行分屏（例如左半为 `files`，右半为 `preview`），两个工具同时处于可见且运行状态。此时若 `dock.activePanelId` 记录的是焦点窗格（如 `files`），顶部的“浏览器”快捷按钮将呈现灰色未激活态，与界面事实冲突。
2. **打开落点未定义**：在分屏状态下，用户点击 `UnitChromeActions` 的“打开文件”或“打开浏览器”按钮时，现有代码调用的是 `openToolInSession(sid, 'files')`。在分屏树中，该面板究竟应当在当前聚焦窗格（`activeLeafId`）打开？还是在新分割窗格打开？还是若已存在则直接聚焦？方案 01-04 全程对此未有一字提及，属于完全遗漏的交互断层。

---

## 六、审计改进强制要求与整改行动指南（Actionable Checklist）

为确保战役能够平稳推进，主控 Agent 必须组织对方案进行下列刚性修订：

| 序号 | 冲突/遗漏项 | 修复行动指令 | 责任方案文件 |
| :---: | :--- | :--- | :--- |
| **ACT-01** | **契约与字段命名统一** | 强行废除方案 02 中的 `DockNode`、`tabs`、`activeTabId`、`dockTree` 命名；统一全方案为方案 01 的 `DockLayoutTree`、`panelIds`、`activePanelId: string \| null` 与 `layout?: DockLayoutTree`。 | `00-总方案.md`<br/>`02-右坞容器.md` |
| **ACT-02** | **展平函数签名对齐** | 统一 `flattenDockTree` 签名为接收 `(tree: DockLayoutTree)`，输出规范化的 `leaves: FlatDockLeaf[]` 与带 `sash` 几何线段的 `branches: FlatDockBranch[]`。 | `02-右坞容器.md` |
| **ACT-03** | **重写顶栏反逃逸门禁** | 彻底删除方案 04 在 `tabsContainer` 上的无效 `onPointerEnter/Move` 伪代码；改在 `SessionTabDragContext.tsx` 的 `flush()` 判定流中增加针对 `data-reject-dock-tools` 与 `domain === 'conex://drag-dock-tool'` 的**主动短路拦截**。 | `04-拖拽体系.md` |
| **ACT-04** | **切断独立终端右坞触发器** | 改造 `TreeLeafPanel.tsx:490`，将抽屉按钮渲染守卫修改为：`isChatSurface && !isLeafDraft && !activeTab?.isStandalone`；并在生成 `mainCtx` 时对 `isStandalone` 强行置空 `sessionId`，杜绝会话串味。 | `03-顶栏收敛.md` |
| **ACT-05** | **裁决 TabStrip 架构** | 明确 `LeafToolTabStrip` 的生命周期：裁决将其降级收敛，将其中的通用 Tab 渲染抽离为轻量组件 `DockPaneTabStrip`，同时保留 `SidePanelNavToolbar` 并将其挂载到 Webview 窗格内部。 | `00-总方案.md`<br/>`02-右坞容器.md` |
| **ACT-06** | **补全 UnitChrome 联动规范** | 明确多窗格下 `UnitChromeActions` 的判定规范：高亮改为只要分屏树任一可见叶子包含对应 `panelId` 即点亮；点击已存在面板时聚焦该叶片，不存在时在当前 `activeLeafId` 内激活。 | `01-数据契约.md`<br/>`02-右坞容器.md` |

---
*审计报告编制完成。本报告秉持严苛架构审计原则，直面冲突与断层，为 Crish 右坞分屏系统的稳健落地筑牢地基。*
