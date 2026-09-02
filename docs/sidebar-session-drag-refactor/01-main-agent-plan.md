# 主 Agent 方案：侧栏会话列表拖拽重构与跨域二叉树分屏统一架构方案

> **方案密级**：核心架构方案  
> **文档位置**：`docs/sidebar-session-drag-refactor/01-main-agent-plan.md`  
> **设计原则**：1D 轴向同构、零打补丁、零伪兼容、拖拽运行期零 Store 污染、跨域分屏自洽互斥、立体验证闭环。

---

## 1. 现状痛点与深层病理解析

从现场截图与代码审查中，可以穿透出侧栏拖拽与顶栏拖拽割裂所造成的 4 大架构断层：

```
[ 当前分裂架构 ]
┌───────────────────────────────┐       ┌─────────────────────────────────┐
│ 侧栏拖拽 (useSessionListDrag)   │       │ 顶栏拖拽 (SessionTabDragContext) │
├───────────────────────────────┤       ├─────────────────────────────────┤
│ • 粗暴 cloneNode 导致文本重叠    │ 孤 立 │ • 优雅 GhostPill (180px 截断)   │
│ • 生硬 inset 绿线 (无让位)    │ 割 裂 │ • translateX 双向对称让位动画   │
│ • pointermove 高频改 Store    │ ───╳──│ • 跨窗格二叉树 22% 边缘分屏     │
│ • 无法跨域拖向右侧工作区分屏  │       │ • 垂直 12px 防抖滞后死区        │
└───────────────────────────────┘       └─────────────────────────────────┘
```

1. **DOM 视觉重叠与脏渲染**：
   - `buildGhostFromRow` 直接 `el.cloneNode(true)` 克隆整行 `li`，包含更多按钮、时间、角标等全部交互元素，成为巨大杂乱的 DOM 块；
   - 被拖拽的源列表项未做占位虚化，浮层飘在原项上方时形成**双重文本错位叠加**（如用户截图中“请完成一个多步骤...”与底层重叠）；
2. **缺乏几何让位，硬编码生硬绿线**：
   - 目标项通过 `.dropBefore` / `.dropAfter` 添加 `box-shadow: inset 0 ±2px 0 0 var(--accent-primary)`，没有像顶栏 Tab 那样通过 CSS Transform 留出物理插入槽位；
3. **高频写入破坏渲染性能**：
   - 在 `pointermove` 过程中只要鼠标掠过某一行就调用 `onMoveSessionRealtime` 修改 Redux/Project Store，破坏了“拖拽中只做轻量 DOM 视觉响应，松手时才原子提交”的架构原则；
4. **跨域孤立，无法向右分屏**：
   - 侧栏拖拽被限制在侧栏容器内，指针一旦移出侧栏，拖拽即刻失效，用户无法从列表直接把历史会话拖到工作区分屏查看。

---

## 2. 1D 轴向纯数学位移引擎（Axis-Agnostic Math Engine）

### 2.1 轴向同构模型
将水平标签栏（Strip）与垂直会话列表（Session List）的几何计算统一收敛至抽象纯函数 `computeAxisOffsets`：

```ts
export interface AxisOffsetInput {
  /** 目标容器中现有项总数（已排除源项） */
  itemCount: number;
  /** 源项在当前容器中的原始下标；跨列表或从外部拖入时为 null */
  sourceIndex: number | null;
  /** 当前计算出的目标插入位置 (0 <= insertIndex <= itemCount) */
  insertIndex: number;
  /** 单个槽位的位移步长 (像素) */
  shiftPx: number;
}
```

### 2.2 严格数学公式推导

设现有项下标集合为 $I = \{0, 1, \dots, n-1\}$，步长为 $S = \text{shiftPx}$，插入目标点为 $k = \text{insertIndex}$：

#### 情况 A：同列表内重排序（`sourceIndex = s !== null`）
- 当 $k > s$（向后 / 向下拖动）：
  $$\text{Offset}(i) = \begin{cases} -S, & \text{若 } s \le i < k \\ 0, & \text{其他} \end{cases}$$
  *物理意义*：位于区间 $[s, k-1]$ 的项向前/向上平移 1 个槽位补位，**绝不向后多推产生双倍鸿沟**。
- 当 $k < s$（向前 / 向上拖动）：
  $$\text{Offset}(i) = \begin{cases} +S, & \text{若 } k \le i < s \\ 0, & \text{其他} \end{cases}$$
  *物理意义*：位于区间 $[k, s-1]$ 的项向后/向下平移 1 个槽位腾出新位置。
- 当 $k = s$（原地）：$\forall i \in I, \text{Offset}(i) = 0$。

#### 情况 B：跨列表 / 跨文件夹拖入（`sourceIndex = null`）
- 当从外部拖入位置 $k$ 时：
  $$\text{Offset}(i) = \begin{cases} +S, & \text{若 } i \ge k \\ 0, & \text{若 } i < k \end{cases}$$
  *物理意义*：插入点之后的所有项统一向后/向下平移 1 个槽位；末尾追加（$k = n$）时所有项位移恒为 0。

### 2.3 插入点 1/3 滞后防抖算法（Vertical Hysteresis）
对于垂直会话列表项（高度 $H = 36\text{px}$，间距 $G = 2\text{px}$，步长 $S = 38\text{px}$）：
- **向下移动时**（$dy > 0$）：指针纵坐标越过目标项的 **上 1/3**（$y > \text{top} + \frac{1}{3}H$）才判定为后插（`insertIndex = i + 1`）；
- **向上移动时**（$dy < 0$）：指针纵坐标越过目标项的 **下 1/3**（$y < \text{bottom} - \frac{1}{3}H$）才判定为前插（`insertIndex = i`）；
- **收益**：彻底消除指针在行边界微动时让位动画频繁抖动的问题。

---

## 3. 侧栏交互与 DOM 卫生重构

### 3.1 统一 Ghost Pill 胶囊规范
废弃 `cloneNode`，复用成熟的 `createGhostPill` 规范：
- **尺寸与几何**：`height: 28px; min-width: 60px; max-width: 200px; padding: 0 10px; border-radius: 7px;`；
- **排版与样式**：
  - 纯白/深色卡片底色：`var(--bg-card)`；
  - 柔和发丝微边框：`1px solid var(--border-color)`；
  - 柔和扩散阴影：`box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12)`；
  - 标题单行省略截断：`white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`；
  - 抓取点动态对齐（光标锁定在胶囊中心区域）。

### 3.2 源项占位虚化机制
- 当拖拽触发时，给当前被拖拽的源列表项 DOM 注入 `data-drag-source="true"`；
- CSS 规则：
  ```css
  .sessionItemWrap[data-drag-source="true"] {
    opacity: 0.35;
    pointer-events: none;
  }
  ```
- **收益**：原位置保持 36px 占位空间防止布局坍塌，同时 0.35 虚化明确表示“已被抓起”，彻底消灭双层重叠。

### 3.3 移除死板绿线，接入平滑 translateY 让位
- 彻底删除 `SidebarSessionList.module.css` 中的 `.dropBefore` 与 `.dropAfter`；
- 目标列表项在 DOM 采集后，根据 `computeAxisOffsets` 纯函数计算出的 offsets 数组直接赋予：
  ```css
  el.style.transition = 'transform 140ms cubic-bezier(0.2, 0, 0, 1)';
  el.style.transform = offset !== 0 ? `translateY(${offset}px)` : '';
  ```

### 3.4 拖拽过程零 Store 污染
- 拖拽过程中只在局部 RAF 动画帧内更新 DOM Transform；
- 只有在 `pointerup` 并且处于 `sidebar-list` 区域时，才调用 `onMoveSessionRealtime(sessionId, targetSessionId, folder, isPinned)` 进行**单次原子提交**。

---

## 4. 跨域工作区交互与分屏互斥守门

### 4.1 跨域目标统一探测器
在指针主循环 `flush()` 中，同时检测左侧栏和右侧二叉树工作区：

```ts
export type CrossDragDropTarget =
  | { kind: 'sidebar-list'; overSessionId: string | null; place: 'before' | 'after'; folder: string; isPinned: boolean }
  | { kind: 'strip'; targetLeafId: string; insertIdx: number }
  | { kind: 'pane'; targetLeafId: string; region: PaneDropRegion };
```

1. **指针在侧栏内**（`x <= sidebarRight`）：
   - 激活垂直列表让位计算；
   - 隐藏全局工作区 Indicator；
   - 目标定为 `kind: 'sidebar-list'`。
2. **指针移入右侧工作区**（`x > sidebarRight`）：
   - 立即清理侧栏内所有的 `translateY` 让位位移（`leaveSessionList`）；
   - 优先检测是否落在某个窗格的顶栏 `data-pane-header="true"`：
     - 若命中顶栏：激活顶栏水平让位（`applyStrip`），目标定为 `kind: 'strip'`；
   - 若落在窗格内容区：
     - 执行 22% 边缘检测（`detectPaneDropRegion`）；
     - 显示分屏指示框（`indicator`），目标定为 `kind: 'pane'`。

### 4.2 严格互斥守门矩阵（Mutual Exclusion Guard）

为避免用户在单窗口模式下拖拽当前正在查看的会话产生无意义的自自分裂，制定如下互斥真值表：

| 场景 | 工作区总叶数 | 被拖会话状态 | 指针位于右侧时的行为 | 守门裁决 |
| :--- | :--- | :--- | :--- | :--- |
| **场景 1** | $N = 1$（单窗口） | 正在当前叶子展示（`active`） | **禁用分屏指示器**，`target = null` | 🚫 **互斥拦截**（仅允许侧栏内重排序） |
| **场景 2** | $N = 1$（单窗口） | 未在当前叶子展示（其他历史会话） | 激活 22% 分屏指示器，松手创建新叶 | ✅ **放行分屏** |
| **场景 3** | $N > 1$（多窗口） | 正在某个叶子展示 | 允许拖到其他叶子边缘分屏或顶栏插入 | ✅ **放行协作** |
| **场景 4** | $N > 1$（多窗口） | 未在任何叶子展示 | 自由分屏或插入任意叶子顶栏 | ✅ **完全放行** |

**守门逻辑代码实现**：
```ts
function isSplitAllowed(
  tree: LayoutTree,
  draggedSessionId: string,
  targetLeafId: string
): boolean {
  const leaves = collectLeaves(tree.root);
  if (leaves.length === 1) {
    const singleLeaf = leaves[0]!;
    const activeTab = singleLeaf.tabs.find((t) => t.tabId === singleLeaf.activeTabId);
    if (activeTab && activeTab.sessionId === draggedSessionId) {
      // 单叶且拖拽当前活动会话：禁止向右分屏
      return false;
    }
  }
  return true;
}
```

---

## 5. 落点提交事务模型（Atomic Commit Transaction）

在 `sessionTabDropCommit.ts` 中扩展通用分发函数 `commitSessionDragDrop`：

```ts
export function commitSessionDragDrop(input: {
  sessionId: string;
  sourceLeafId: string | null; // 从侧栏拖拽时为 null
  target: CrossDragDropTarget;
  onSidebarMove?: (sessionId: string, targetId: string | null, folder: string, isPinned: boolean) => void;
}): void {
  const { sessionId, sourceLeafId, target, onSidebarMove } = input;
  const treeStore = useLayoutTreeStore.getState();

  switch (target.kind) {
    case 'sidebar-list': {
      onSidebarMove?.(
        sessionId,
        target.overSessionId,
        target.folder,
        target.isPinned
      );
      break;
    }
    case 'strip': {
      if (sourceLeafId) {
        // Tab 间移动
        treeStore.moveTab(sourceLeafId, sessionId, target.targetLeafId, target.insertIdx);
      } else {
        // 侧栏拖入顶栏：在目标叶打开会话
        treeStore.openSession(sessionId, { activeLeafId: target.targetLeafId });
      }
      break;
    }
    case 'pane': {
      if (sourceLeafId) {
        // Tab 边缘分屏
        treeStore.splitTab(sourceLeafId, sessionId, target.targetLeafId, target.region);
      } else {
        // 侧栏拖入窗格边缘分屏：在目标叶旁 split 出新叶并打开会话
        treeStore.splitSession(sessionId, target.targetLeafId, target.region);
      }
      break;
    }
  }
}
```

---

## 6. 拟修改文件与重构清单

### [MODIFY] [sessionTabDragFeel.ts](file:///c:/Software/conex/apps/crish-desktop/src/components/shell/sessionTabDragFeel.ts)
- 将 `computeStripTabOffsets` 升级为通用 `computeAxisOffsets`，参数扩展为通用 1D 轴向模型；
- 导出 `SIDEBAR_SESSION_ROW_HEIGHT = 36` 与 `SIDEBAR_SESSION_ROW_GAP = 2` 常量。

### [MODIFY] [sessionTabDragDom.ts](file:///c:/Software/conex/apps/crish-desktop/src/components/shell/sessionTabDragDom.ts)
- 增加 `collectVerticalListItems` 与 `shiftVerticalListItems`，支持垂直列表的 `translateY` 顺滑让位与恢复；
- 扩展 `createGhostPill`，支持从列表项提取会话标题生成标准轻量胶囊。

### [MODIFY] [useSessionListDrag.ts](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/useSessionListDrag.ts)
- 全面重构为基于 1D 轴向位移与跨域分屏的状态机：
  - 引入 `data-drag-source="true"` 占位虚化；
  - 移除 `cloneNode` 与高频 `onMoveSessionRealtime`；
  - 接入跨域工作区探测（顶栏 TabStrip 与 22% 边缘 Split）；
  - 接入单窗口同会话互斥守门；
  - 松手时调用 `commitSessionDragDrop` 执行原子提交。

### [MODIFY] [SidebarSessionList.module.css](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css)
- 彻底删除 `.dropBefore` 与 `.dropAfter`；
- 添加 `.sessionItemWrap[data-drag-source="true"]` 占位虚化样式。

### [MODIFY] [layoutTreeStore.ts](file:///c:/Software/conex/apps/crish-desktop/src/store/layout-tree/layoutTreeStore.ts) & [layoutTreeInsert.ts](file:///c:/Software/conex/apps/crish-desktop/src/store/layout-tree/layoutTreeInsert.ts)
- 在二叉树核心层增加 `splitSession(sessionId, dstLeafId, region)` 纯函数命令，支持从未打开的 `sessionId` 直接在目标叶旁切分出新叶。

---

## 7. 全景立体验证计划（遵守 AGENTS.md §7.1）

### 7.1 第 1 层：静态契约底线（Static Soundness）
- 执行 `npm run typecheck`，确保 TypeScript 全仓零类型错误、零签名漂移。

### 7.2 第 2 层：领域逻辑与状态机不变量断言（Math & Invariants）
- 新建 `sessionListDragFeel.test.ts`，穷举测试：
  1. 垂直同列表向下拖拽：区间项向上补位（$-38\text{px}$）；
  2. 垂直同列表向上拖拽：区间项向下腾位（$+38\text{px}$）；
  3. 跨文件夹/跨 Pin 区拖入：插入点后所有项向下腾位；
  4. 互斥守门函数测试：单叶同会话返回 `false`，单叶不同会话返回 `true`，多叶同会话返回 `true`。

### 7.3 第 3 层：系统级规范守门（Guardrails）
- 运行 `antiDarkeningGuard.test.ts` 与 `style-contract.test.ts`，确保零原生 `title=`、零未授权颜色混入、零私有滚动条。

### 7.4 第 4 层：真实宿主现场验收（Live Runtime）
- 启动 `npm run dev:workbench`，通过 4000 Tauri MCP Socket 实测：
  1. 侧栏拖拽启动：原列表项 0.35 虚化，GhostPill 居中跟随光标，无任何文本重叠；
  2. 侧栏内部拖动：下方列表项顺滑向下平移 38px 腾出空白槽位，松手准确排序；
  3. 侧栏拖出到右侧单窗口（当前会话）：无分屏指示框出现（互斥生效）；
  4. 侧栏拖出其他会话到右侧工作区：窗格边缘 22% 准确高亮绿色分屏框，松手成功切分为双窗口并打开该会话；
  5. 控制台日志零 Warning、零 Uncaught Exception。

### 7.5 第 5 层：架构纯洁性与负产出审计（Clean Architecture）
- `git diff` 审计：彻底清退生硬绿线 CSS、废弃 `cloneNode` 脏 DOM、消除 `pointermove` 高频 Store 写入，实现架构净收敛。
