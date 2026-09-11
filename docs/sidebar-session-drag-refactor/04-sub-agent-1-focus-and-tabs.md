# 分屏焦点联动、标签行视觉同构与跨域顶栏自由排序独立详案 (Sub-Agent Deep Design)

> **文档定位**：`docs/sidebar-session-drag-refactor/04-sub-agent-1-focus-and-tabs.md`
> **所属战役**：`docs/sidebar-session-drag-refactor/` 侧栏会话列表拖拽重构与跨域分屏体系
> **架构契约**：严格遵循 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §1（逻辑规划与反退避）、§7（严禁补丁/作弊）、§7.1（立体验证纪律）、§8（反过度设计硬性红线）。
> **核心领域**：二叉树布局系统（[`layoutTreeStore`](file:///c:/Software/conex/apps/crish-desktop/src/store/layout-tree/layoutTreeStore.ts)）、工作区门面（[`workspaceShellStore`](file:///c:/Software/conex/apps/crish-desktop/src/store/workspace-shell/workspaceShellStore.ts)）、会话领域中心（[`sessionStore`](file:///c:/Software/conex/apps/crish-desktop/src/store/sessionStore.ts)）、跨域动力学路由（[`crossDomainDropRouter`](file:///c:/Software/conex/apps/crish-desktop/src/components/shell/drag-engine/crossDomainDropRouter.ts)）与顶栏组件（[`PaneHeader`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/PaneHeader.tsx) / [`LeafToolTabStrip`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx)）。

---

# 目录索引

- [一、 核心命题与架构断言](#一-核心命题与架构断言)
- [二、 3 大核心断层深入剖析与根因链](#二-3-大核心断层深入剖析与根因链)
  - [2.1 分屏切分后焦点断裂与三 Store 协调脱节根因](#21-分屏切分后焦点断裂与三-store-协调脱节根因)
  - [2.2 侧栏与顶栏标签视觉碎片化根因（高度与圆角撕裂）](#22-侧栏与顶栏标签视觉碎片化根因高度与圆角撕裂)
  - [2.3 侧栏跨域拖入顶栏（TabStrip）无序追加与零让位根因](#23-侧栏跨域拖入顶栏tabstrip无序追加与零让位根因)
- [三、 三 Store 状态机时序协调与焦点原子收敛机制](#三-三-store-状态机时序协调与焦点原子收敛机制)
  - [3.1 权威职责单一真理源（SSOT）拓扑](#31-权威职责单一真理源ssot拓扑)
  - [3.2 跨域分屏事务提交流程（`splitSessionFromSidebar` 原子协议）](#32-跨域分屏事务提交流程splitsessionfromsidebar-原子协议)
  - [3.3 激活态同步与微任务焦点转移（Zero-Click Activation）](#33-激活态同步与微任务焦点转移zero-click-activation)
- [四、 28px 高度与 8px 圆角全域视觉同构方案](#四-28px-高度与-8px-圆角全域视觉同构方案)
  - [4.1 几何与设计 Token 对齐矩阵](#41-几何与设计-token-对齐矩阵)
  - [4.2 `PaneHeader.module.css` 升级重构](#42-paneheadermodulecss-升级重构)
  - [4.3 `LeafToolTabStrip.module.css` 升级重构](#43-leaftooltabstripmodulecss-升级重构)
  - [4.4 侧栏与顶栏交互微动效曲线同构](#44-侧栏与顶栏交互微动效曲线同构)
- [五、 跨域 1D 水平动力学让位与行内自由排序引擎](#五-跨域-1d-水平动力学让位与行内自由排序引擎)
  - [5.1 1D 水平连续未位移解算与滞后插值数学模型](#51-1d-水平连续未位移解算与滞后插值数学模型)
  - [5.2 跨域滑入/滑出 TabStrip 的 DOM 状态机与 GPU `translateX` 平滑让位](#52-跨域滑入滑出-tabstrip-的-dom-状态机与-gpu-translatex-平滑让位)
  - [5.3 指定下标 $k$ 的原子提交与唯一性迁移（Insert vs Move vs Reorder）](#53-指定下标-k-的原子提交与唯一性迁移insert-vs-move-vs-reorder)
- [六、 全链路重构代码落地蓝图](#六-全链路重构代码落地蓝图)
  - [6.1 改造 `sessionTabDropCommit.ts`](#61-改造-sessiontabdropcommitts)
  - [6.2 改造 `workspaceShellStore.ts` 与 `treeSessionCommands.ts`](#62-改造-workspaceshellstorets-与-treesessioncommandsts)
  - [6.3 改造 `layoutTreeInsert.ts` 与 `layoutTreeStore.ts`](#63-改造-layouttreeinsertts-与-layouttreestorets)
  - [6.4 改造 `useSessionListDrag.ts`](#64-改造-usesessionlistdragts)
  - [6.5 改造 `crossDomainDropRouter.ts`](#65-改造-crossdomaindroprouterts)
- [七、 五层立体验证模型与测试用例设计](#七-五层立体验证模型与测试用例设计)

---

# 一、 核心命题与架构断言

在 Conex / Crish 桌面客户端的布局与交互演进中，多窗口分屏与拖拽重排构成了核心生产力交互基座。本方案针对以下 3 大核心命题进行彻底解构与系统化重构设计：

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 【 3 大核心命题与架构断言 】                                    │
├───────────────────┬─────────────────────────────────────────────────────────────────────────────┤
│ 命题              │ 架构断言                                                                    │
├───────────────────┼─────────────────────────────────────────────────────────────────────────────┤
│ 1. 焦点与激活联动 │ 窗格切分 / 会话拖入落位瞬间，必须原子化完成「二叉树拓扑切分 + 新窗格 Leaf  │
│                   │ 激活 + 会话领域 activeSessionId 同步 + DOM 焦点无缝转移」，彻底根除必须点  │
│                   │ 击一下才呈现内容与状态错位的病态。                                          │
├───────────────────┼─────────────────────────────────────────────────────────────────────────────┤
│ 2. 视觉同构语言   │ 侧栏会话卡片与顶栏 TabStrip（会话标签 + 工具抽屉标签）全面统一为 28px       │
│                   │ 严格物理高度、8px 圆角胶囊规范，实现桌面客户端跨区域视觉语言的绝对同构。    │
├───────────────────┼─────────────────────────────────────────────────────────────────────────────┤
│ 3. 跨域行内自由排 │ 从侧栏抓起会话卡片拖入右侧任意窗格顶栏 TabStrip 时，顶栏标签必须以          │
│    序动力学       │ 140ms cubic-bezier 平滑产生水平 translateX 让位腾出槽位，松手后在指定下标   │
│                   │ $k$ 处精确插入并自动聚焦，杜绝只能生硬追加在末尾。                          │
└───────────────────┴─────────────────────────────────────────────────────────────────────────────┘
```

---

# 二、 3 大核心断层深入剖析与根因链

## 2.1 分屏切分后焦点断裂与三 Store 协调脱节根因

### 病理现象
用户从侧栏将会话卡片拖拽至右侧二叉树工作区边缘（如右侧 22% 区域）松手后：
1. 几何上成功切分出了新的窗格（Leaf）；
2. 但新建窗格没有自动获得激活聚焦，侧栏选中高亮仍停留在原先会话，顶部工具栏与全局状态仍指向旧窗格；
3. 必须由用户在新建窗格的空白区域或 Composer 手动点击一次，界面才更新为新会话内容。

### 根因分析（时序追踪）

代码审查揭示了底层的三 Store 通信断层：

```
【 历史错误调用链 】
[useSessionListDrag.ts] onPointerUp
  └─► [sessionTabDropCommit.ts] commitSidebarSessionDrop()
        └─► useLayoutTreeStore.getState().splitSessionFromSidebar(...)
              ├─► 仅更新 layoutTreeStore.tree 与 activeLeafId (freshLeaf.id)
              ├─► ❌ 未通知 workspaceShellStore (lastChatLeafId 仍为旧 Leaf)
              ├─► ❌ 未通知 sessionStore (activeSessionId 仍为旧 Session)
              └─► ❌ 未触发 syncSessionFromActiveLeaf()
```

1. **直接穿透调用树存储**：[`sessionTabDropCommit.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/shell/sessionTabDropCommit.ts#L80) 第 80 行直接调用 `useLayoutTreeStore.getState().splitSessionFromSidebar(sessionId, targetLeafId, region)`，彻底绕过了门面层 [`workspaceShellStore`](file:///c:/Software/conex/apps/crish-desktop/src/store/workspace-shell/workspaceShellStore.ts)；
2. **`workspaceShellStore.lastChatLeafId` 滞后**：[`workspaceShellStore.ts`](file:///c:/Software/conex/apps/crish-desktop/src/store/workspace-shell/workspaceShellStore.ts#L112) 中维护的 `lastChatLeafId` 未被同步更新，导致全局查询 `pictureFromActiveLeaf()` 返回的依然是旧叶子；
3. **`sessionStore.activeSessionId` 孤立漂移**：[`useSessionStore.getState().setActiveSessionId(sessionId)`](file:///c:/Software/conex/apps/crish-desktop/src/store/sessionStore.ts#L29) 从未被触发。侧栏列表组件、全局状态栏、Approval 审批坞均基于 `sessionStore.activeSessionId` 渲染，因此全局仍处于旧会话上下文；
4. **为何点击一下才恢复**：用户点击新窗格时，触发了 [`TreeLeafPanel.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx#L161-L181) 的 `handleActivate` -> `sessionShell().activateTab(leaf.id, tabId)` -> [`workspaceShellStore.activateTab`](file:///c:/Software/conex/apps/crish-desktop/src/store/workspace-shell/workspaceShellStore.ts#L162-L168)，此时才终于执行了 `rememberChatLeaf` 与 `syncSessionFromActiveLeaf`。

---

## 2.2 侧栏与顶栏标签视觉碎片化根因（高度与圆角撕裂）

当前客户端的侧栏会话项与顶部 TabStrip 在视觉规格上存在严重割裂：

```
┌────────────────────────────────┬───────────────────────────┬───────────────────────────┐
│ 视觉维度                       │ 侧栏会话列表项            │ 顶栏 TabStrip (PaneHeader)│
├────────────────────────────────┼───────────────────────────┼───────────────────────────┤
│ 物理高度 (Height)              │ 28px                      │ 26px (容器 36px)          │
│ 容器圆角 (Border Radius)       │ var(--radius-lg, 8px)     │ 6px                       │
│ 工具抽屉标签 (LeafToolTabStrip)│ —                         │ 26px 高 / 4px 圆角        │
│ 水平内边距 (Padding)           │ 0 8px 0 10px              │ 0 4px 0 8px               │
│ 字体规格 (Font Size / Weight)  │ 14px / 500                │ 12px / 400 (选中 500)     │
│ 视觉语言表现                   │ 现代大圆角柔和胶囊卡片    │ 旧式微圆角硬标签          │
└────────────────────────────────┴───────────────────────────┴───────────────────────────┘
```

- [`SidebarSessionList.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css#L260-L270)：`.sessionItem` 采用 `height: 28px`，`border-radius: var(--radius-lg)`（8px）；
- [`PaneHeader.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/PaneHeader.module.css#L73-L86)：`.tabItem` 采用 `height: 26px`，`border-radius: 6px`；`.newTabBtn` 采用 `width: 26px; height: 26px; border-radius: 6px;`；
- [`LeafToolTabStrip.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css#L76-L88)：`.tab` 采用 `height: 26px`，`border-radius: var(--radius-sm, 4px)`；
- **视觉断层**：侧栏呈现出极具质感的现代圆润胶囊形态，而顶栏却停留在 26px / 4px~6px 的陈旧比例，两者左右相邻时产生显著的排版失调与视觉心理落差。

---

## 2.3 侧栏跨域拖入顶栏（TabStrip）无序追加与零让位根因

### 病理现象
从侧栏将会话卡片拖拽至右侧窗格的顶栏 TabStrip 时：
1. Tab 栏内的现有标签没有任何水平让位动效（`translateX`），没有像侧栏那样平滑腾出插入空位；
2. 松手后只能调用 `tree.openSession(...)` 粗暴追加在标签数组末尾，无法在指定第 $k$ 个位置自由插入排序。

### 根因分析
1. **跨域落点探测器缺少下标计算**：在 [`crossDomainDropRouter.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/shell/drag-engine/crossDomainDropRouter.ts#L64) 中，命中 TabStrip 时硬编码返回了 `insertIndex: 0`：
   ```typescript
   // 历史遗留硬编码：
   return {
     domain: 'tab-strip',
     targetLeafId,
     stripEl: tabStrip,
     insertIndex: 0, // 尚未接入几何插值
   };
   ```
2. **`useSessionListDrag.ts` 忽略 TabStrip 动力学让位**：在 [`useSessionListDrag.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/useSessionListDrag.ts#L283-L286) 中，当 `target.domain === 'tab-strip'` 时，直接执行了 `clearAllShifts()`，没有调用任何类似于 [`SessionTabDragContext.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/shell/SessionTabDragContext.tsx#L168-L180) 的 `collectStripTabs` 与 `shiftStripTabs`；
3. **`tree.openSession` 缺失 `insertIdx` 支持**：底层树操作 [`layoutTreeInsert.ts`](file:///c:/Software/conex/apps/crish-desktop/src/store/layout-tree/layoutTreeInsert.ts) 与 [`workspaceShellStore.ts`](file:///c:/Software/conex/apps/crish-desktop/src/store/workspace-shell/workspaceShellStore.ts#L138) 的 `openOrFocusSession` 接口仅接受 `{ title, workspaceKey, activeLeafId }`，不支持传入 `insertIdx`。

---

# 三、 三 Store 状态机时序协调与焦点原子收敛机制

## 3.1 权威职责单一真理源（SSOT）拓扑

为了彻底根除焦点脱节，明确划分三个 Store 的绝对权威边界：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              【 三 Store 单一真理源分层架构 】                         │
├───────────────────────────┬────────────────────────────────────────────────────────────┤
│ 存储中心                  │ 权威职责范围 (SSOT)                                        │
├───────────────────────────┼────────────────────────────────────────────────────────────┤
│ 1. useLayoutTreeStore     │ • 二叉树几何拓扑 (Branch / Leaf / SplitRatio)              │
│    (纯几何与树结构)       │ • 叶子内部标签数组 (leaf.tabs: SessionTab[])               │
│                           │ • 几何活动叶 ID (activeLeafId: string)                     │
├───────────────────────────┼────────────────────────────────────────────────────────────┤
│ 2. useWorkspaceShellStore │ • 会话手势与操作门面 (openOrFocusSession / splitSession)   │
│    (协同门面与动作编排)   │ • 记忆最近活跃 Chat 叶 (lastChatLeafId)                    │
│                           │ • 状态同步桥梁 (syncSessionFromActiveLeaf)                 │
├───────────────────────────┼────────────────────────────────────────────────────────────┤
│ 3. useSessionStore        │ • 全局会话领域实体集 (sessions, sessionsById)              │
│    (业务会话实体)         │ • 全局激活会话 ID (activeSessionId)                        │
│                           │ • 会话消息流与草稿状态 (messages, composerDrafts)          │
└───────────────────────────┴────────────────────────────────────────────────────────────┘
```

---

## 3.2 跨域分屏事务提交流程（`splitSessionFromSidebar` 原子协议）

将分屏切分操作升级为微任务级原子事务：

```
                    【 侧栏拖拽分屏 / 顶栏插入原子提交流程 】

 [useSessionListDrag] (pointerup 触发)
         │
         ▼
 [commitSidebarSessionDrop({ sessionId, target })]
         │
         ├───► A. 目标为边缘分屏 (target.kind === 'pane')
         │        │
         │        ▼
         │     [workspaceShellStore.splitSessionFromSidebar(sessionId, targetLeafId, region)]
         │        │
         │        ├─ 1. 调用 tree.splitSessionFromSidebarOp(tree, sessionId, targetLeafId, region)
         │        │     └─► 产生全新 Leaf(id: L_new) 与 Tab(id: T_new, sessionId)
         │        │     └─► layoutTreeStore 写入: { tree: newTree, activeLeafId: L_new }
         │        │
         │        ├─ 2. 状态机原子同步:
         │        │     ├─► workspaceShellStore.set({ lastChatLeafId: L_new })
         │        │     └─► sessionStore.setActiveSessionId(sessionId)
         │        │
         │        └─ 3. 触发聚焦脉冲 (Focus Pulse):
         │              └─► 派发 focusLeafToDom(L_new)
         │
         └───► B. 目标为顶栏插入 (target.kind === 'strip')
                  │
                  ▼
               [workspaceShellStore.openOrFocusSession(sessionId, {
                   activeLeafId: targetLeafId,
                   insertIdx: target.insertIdx
               })]
                  │
                  ├─ 1. 若全树已存在该 session:
                  │     └─► tree.moveTab(srcLeafId, tabId, targetLeafId, insertIdx)
                  │
                  ├─ 2. 若全树不存在:
                  │     └─► tree.insertTab(targetLeafId, createSessionTab(sessionId), insertIdx)
                  │
                  └─ 3. 状态机原子同步:
                        ├─► layoutTreeStore.activateTab(targetLeafId, tabId)
                        ├─► workspaceShellStore.set({ lastChatLeafId: targetLeafId })
                        └─► sessionStore.setActiveSessionId(sessionId)
```

---

## 3.3 激活态同步与微任务焦点转移（Zero-Click Activation）

### 形式化状态机转移方程
设系统初始状态为 $\mathcal{S}_0 = \langle \mathcal{T}_0, L_{\text{old}}, S_{\text{old}} \rangle$，其中：
- $\mathcal{T}_0$ 为当前布局二叉树；
- $L_{\text{old}} = \text{lastChatLeafId} = \text{activeLeafId}$；
- $S_{\text{old}} = \text{activeSessionId}$。

当触发侧栏会话 $s_{\text{drag}}$ 分屏至目标叶 $L_{\text{dst}}$ 的区域 $R \in \{\text{left}, \text{right}, \text{top}, \text{bottom}\}$ 时，状态机发生确定性转移 $\mathcal{S}_0 \xrightarrow{\text{Split}(s_{\text{drag}}, L_{\text{dst}}, R)} \mathcal{S}_1$：

$$\mathcal{T}_1 = \operatorname{splitSessionFromSidebarOp}(\mathcal{T}_0, s_{\text{drag}}, L_{\text{dst}}, R)$$
$$L_{\text{new}} = \operatorname{findLeafBySessionId}(\mathcal{T}_1, s_{\text{drag}})$$
$$\mathcal{S}_1 = \langle \mathcal{T}_1, L_{\text{new}}, s_{\text{drag}} \rangle$$

在单次同步微任务（Microtask / Single Event Loop Turn）中，保证以下断言成立：
1. $\operatorname{activeLeafId}(\text{LayoutTreeStore}) = L_{\text{new}}$；
2. $\operatorname{lastChatLeafId}(\text{WorkspaceShellStore}) = L_{\text{new}}$；
3. $\operatorname{activeSessionId}(\text{SessionStore}) = s_{\text{drag}}$；
4. $\operatorname{activeTabId}(L_{\text{new}}) = \operatorname{findTabId}(L_{\text{new}}, s_{\text{drag}})$。

### DOM 焦点无损联动实现
在 `TreeLeafPanel` 挂载或检测到 `isActive` 由 `false` 跃迁为 `true` 且由拖拽分屏触发时，通过 `requestAnimationFrame` 自动寻找并聚焦其内部的 Composer 输入区域或主视口容器，确保键盘事件立即就绪，彻底免除手动点击。

---

# 四、 28px 高度与 8px 圆角全域视觉同构方案

## 4.1 几何与设计 Token 对齐矩阵

为消除界面排版杂乱感，将侧栏、顶栏会话标签、工具抽屉标签的几何与色彩规范收敛为完全一致的参数集合：

```css
/* ==========================================================================
   全域标签与会话卡片视觉同构设计规范 (Visual Homomorphism Tokens)
   ========================================================================== */
:root {
  /* 统一高度契约 */
  --tab-item-height: 28px;
  --tab-item-btn-size: 28px;
  --pane-header-height: 36px;
  --drawer-header-height: 36px;

  /* 统一圆角契约 (8px 柔和胶囊) */
  --tab-item-radius: var(--radius-lg, 8px);
  --tab-btn-radius: var(--radius-lg, 8px);
  --tab-close-radius: 4px;

  /* 统一字体与字重 */
  --tab-item-font-size: var(--font-size-xs-plus, 12.5px);
  --tab-item-font-weight-normal: 400;
  --tab-item-font-weight-active: 500;
  --tab-item-padding: 0 6px 0 10px;
  --tab-item-gap: 6px;
}
```

```
┌────────────────────────────┬─────────────────────────────┬─────────────────────────────┐
│ 属性                       │ 侧栏会话项 (.sessionItem)   │ 顶栏标签 (.tabItem / .tab)  │
├────────────────────────────┼─────────────────────────────┼─────────────────────────────┤
│ 高度 (Height)              │ 28px                        │ 28px (从 26px 升级)         │
│ 圆角 (Border Radius)       │ 8px (var(--radius-lg))      │ 8px (从 4px/6px 升级)       │
│ 新建/加号按钮尺寸          │ 22px × 22px                 │ 28px × 28px (圆角 8px)      │
│ 关闭按钮尺寸               │ 22px × 22px                 │ 16px × 16px (圆角 4px)      │
│ 容器高度 (Header Height)   │ 自适应列表                  │ 36px (垂直居中 28px 标签)   │
│ 激活态背景 (Active Bg)     │ var(--sidebar-active)       │ var(--bg-card, #ffffff)     │
│ 激活态阴影 (Active Shadow) │ 无 (平面内嵌)               │ var(--shadow-sm)            │
│ 悬浮态背景 (Hover Bg)      │ var(--sidebar-hover)        │ var(--bg-hover)             │
│ 动力学过渡曲线             │ 140ms cubic-bezier(.2,0,0,1)│ 140ms cubic-bezier(.2,0,0,1)│
└────────────────────────────┴─────────────────────────────┴─────────────────────────────┘
```

---

## 4.2 `PaneHeader.module.css` 升级重构

对 [`PaneHeader.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/PaneHeader.module.css) 进行精确重构，将高度锁定为 28px，圆角统一为 8px：

```css
/* 窗格顶部会话标签项 (28px 严格对标侧栏胶囊卡片) */
.tabItem {
  height: 28px;
  min-height: 28px;
  max-height: 28px;
  max-width: 180px;
  min-width: 0;
  flex: 0 1 150px;
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 0 6px 0 10px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-lg, 8px);
  font-size: var(--font-size-xs-plus, 12.5px);
  font-weight: 400;
  color: var(--text-secondary, #555555);
  cursor: pointer;
  white-space: nowrap;
  box-sizing: border-box;
  user-select: none;
  overflow: hidden;
  -webkit-app-region: no-drag;
  app-region: no-drag;
  transition:
    background var(--dur-fast, 120ms) var(--ease-default, ease-out),
    color var(--dur-fast, 120ms) var(--ease-default, ease-out),
    border-color var(--dur-fast, 120ms) var(--ease-default, ease-out),
    box-shadow var(--dur-fast, 120ms) var(--ease-default, ease-out),
    transform 140ms cubic-bezier(0.2, 0, 0, 1),
    max-width 220ms cubic-bezier(0.16, 1, 0.3, 1),
    flex-basis 220ms cubic-bezier(0.16, 1, 0.3, 1),
    padding 220ms cubic-bezier(0.16, 1, 0.3, 1),
    margin 220ms cubic-bezier(0.16, 1, 0.3, 1),
    opacity 180ms ease;
}

.tabItem:hover:not(.tabItemActive) {
  background: var(--bg-hover);
  border-color: transparent;
  color: var(--text-primary);
}

.tabItemActive {
  background: var(--bg-card, #ffffff);
  color: var(--text-primary);
  font-weight: 500;
  border-color: var(--border-subtle);
  box-shadow: var(--shadow-sm);
}

.tabItemActive:hover {
  background: var(--bg-card, #ffffff);
  border-color: var(--border-color);
  box-shadow: var(--shadow-md);
}

/* 新建标签按钮（加号）- 28px × 28px / 8px 圆角 */
.newTabBtn {
  width: 28px;
  height: 28px;
  min-width: 28px;
  flex: 0 0 28px;
  padding: 0;
  border-radius: var(--radius-lg, 8px);
  border: 1px solid transparent;
  background: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  cursor: pointer;
  -webkit-app-region: no-drag;
  app-region: no-drag;
  transition:
    background var(--dur-fast, 120ms) var(--ease-default, ease-out),
    color var(--dur-fast, 120ms) var(--ease-default, ease-out),
    opacity 160ms var(--ease-default, ease-out),
    transform 120ms var(--ease-default, ease-out);
}

.newTabBtn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.newTabBtn:active {
  transform: scale(0.94);
  background: var(--bg-active);
}
```

---

## 4.3 `LeafToolTabStrip.module.css` 升级重构

对 [`LeafToolTabStrip.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css) 进行同步重构，统一为 28px / 8px 圆角：

```css
/* 工具抽屉头部标签项 (28px / 8px 圆角) */
.tab {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  height: 28px;
  min-height: 28px;
  max-height: 28px;
  max-width: 140px;
  min-width: 0;
  flex: 0 0 auto;
  padding: 0 6px 0 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-lg, 8px);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-size-xs-plus, 12px);
  font-family: inherit;
  font-weight: 400;
  cursor: pointer;
  white-space: nowrap;
  box-sizing: border-box;
  user-select: none;
  overflow: hidden;
  transition:
    background-color var(--transition-micro, 120ms) ease,
    color var(--transition-micro, 120ms) ease,
    border-color var(--transition-micro, 120ms) ease,
    transform 140ms cubic-bezier(0.2, 0, 0, 1),
    max-width 220ms cubic-bezier(0.16, 1, 0.3, 1),
    padding 220ms cubic-bezier(0.16, 1, 0.3, 1),
    margin 220ms cubic-bezier(0.16, 1, 0.3, 1),
    opacity 180ms ease;
}

.tab:hover:not(.tabActive) {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.tabActive {
  background: var(--bg-card, #ffffff);
  color: var(--text-primary);
  font-weight: 500;
  border-color: var(--border-subtle);
  box-shadow: var(--shadow-sm);
}

.addBtn,
.sideBtn {
  width: 28px;
  height: 28px;
  min-width: 28px;
  flex: 0 0 28px;
  padding: 0;
  border-radius: var(--radius-lg, 8px);
  border: 1px solid transparent;
  background: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    background-color var(--transition-micro, 120ms) ease,
    color var(--transition-micro, 120ms) ease,
    transform 120ms ease;
}

.addBtn:hover,
.sideBtn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
```

---

# 五、 跨域 1D 水平动力学让位与行内自由排序引擎

## 5.1 1D 水平连续未位移解算与滞后插值数学模型

### 静态未位移水平坐标映射 (Static Horizontal Geometry Unwarping)
当 TabStrip 内的标签因拖拽发生动态平移时，DOM 的实时 `getBoundingClientRect()` 包含了 `translateX` 的形变。为了保证空间判定的绝对确定性与零振荡，必须进行反向坐标解算：

$$\operatorname{StaticLeft}(i) = \operatorname{BoundingLeft}(i) - \operatorname{readTranslateX}(\text{Tab}_i)$$
$$\operatorname{StaticRight}(i) = \operatorname{BoundingRight}(i) - \operatorname{readTranslateX}(\text{Tab}_i)$$

### 1D 水平中点与方向感知滞后插值方程
设目标 TabStrip 内肉眼可见的 $M$ 个标签静态区间序列为：
$$\mathcal{X} = [ [x_{\min}(0), x_{\max}(0)], [x_{\min}(1), x_{\max}(1)], \dots, [x_{\min}(M-1), x_{\max}(M-1)] ]$$

定义相邻标签过渡中点序列 $\mathcal{C} = [c_0, c_1, \dots, c_M]$：
$$c_0 = -\infty$$
$$c_k = \frac{x_{\max}(k-1) + x_{\min}(k)}{2}, \quad \forall k \in [1, M-1]$$
$$c_M = +\infty$$

方向感知滞后因子 $\delta_k = \frac{1}{3} (x_{\max}(k) - x_{\min}(k))$。插入索引求解方程 $\Theta_x(x, v_x) \to [0, M]$：

$$\Theta_x(x, v_x) = \begin{cases}
0, & \text{若 } x \le x_{\min}(0) \\
M, & \text{若 } x \ge x_{\max}(M-1) \\
k+1, & \text{若 } v_x \ge 0 \land x \ge x_{\min}(k) + \delta_k \\
k, & \text{若 } v_x < 0 \land x \le x_{\max}(k) - \delta_k \\
k, & \text{其它情况}
\end{cases}$$

---

## 5.2 跨域滑入/滑出 TabStrip 的 DOM 状态机与 GPU `translateX` 平滑让位

### 跨域动力学让位定理（Horizontal Shift Theorem）
当从侧栏拖入会话至目标 TabStrip 时（此时源项不在目标 TabStrip 中，属于纯跨域插入 $s_{\text{source}} = \text{null}$）：

设当前插入索引为 $k \in [0, M]$，槽位腾位宽度步长为 $W_{\text{slot}} = 154\text{px}$（标准标签宽度 150px + 间距 4px）。
位移向量 $\mathbf{H}[i]$ 满足严格的阶跃方程：

$$\mathbf{H}[i] = \begin{cases}
0, & \forall i \in [0, k-1] \quad (\text{插入点左侧项保持原位}) \\
+W_{\text{slot}}, & \forall i \in [k, M-1] \quad (\text{插入点及右侧所有项向右平移腾出槽位})
\end{cases}$$

当 $k = M$（末尾追加）时，$\forall i \in [0, M-1], \mathbf{H}[i] = 0$。

### 状态机生命周期：
1. **`Enter TabStrip`**：
   - 采集目标 TabStrip 内部所有可见 `[role="tab"]` 的静态解算几何；
   - 注入 `transition: transform 140ms cubic-bezier(0.2, 0, 0, 1)`；
2. **`Hover & Slide`**：
   - 每帧根据光标 $(x, v_x)$ 求解 $k = \Theta_x(x, v_x)$；
   - 对 $i \ge k$ 注入 `translateX(+154px)`，对 $i < k$ 恢复 `translateX(0)`；
3. **`Leave TabStrip`**：
   - 当光标滑出 TabStrip 区域或进入分屏 Pane 区域时，立即执行 `leaveStrip(stripEl)` 清空所有 `style.transform` 与 `style.transition`；
4. **`Drop on TabStrip`**：
   - 同步获取锁定终态 $k$，立即派发原子提交。

---

## 5.3 指定下标 $k$ 的原子提交与唯一性迁移（Insert vs Move vs Reorder）

提交至顶栏时，处理三种拓扑分支：

```typescript
export function commitTabStripInsertion(
  sessionId: string,
  targetLeafId: string,
  insertIdx: number
): void {
  const treeStore = useLayoutTreeStore.getState();
  const root = treeStore.tree.root;

  // 1. 查找全树是否已存在该 session 的 Tab
  const allLeaves = collectLeaves(root);
  let existingLoc: { leafId: string; tabId: string } | null = null;
  for (const leaf of allLeaves) {
    const t = leaf.tabs.find((tab) => tab.sessionId === sessionId);
    if (t) {
      existingLoc = { leafId: leaf.id, tabId: t.tabId };
      break;
    }
  }

  if (existingLoc) {
    // 分支 A：会话已打开 -> 跨 Leaf 迁移或同 Leaf 重排序 (moveTab)
    treeStore.moveTab(existingLoc.leafId, existingLoc.tabId, targetLeafId, insertIdx);
  } else {
    // 分支 B：会话未打开 -> 在指定位置插入新 Tab (insertTab)
    const newTab = createSessionTab({
      tabId: generateNodeId('tab'),
      sessionId,
    });
    const nextTree = insertTabOp(treeStore.tree, targetLeafId, newTab, insertIdx);
    treeStore.setTree(nextTree);
  }

  // 2. 触发三 Store 原子同步
  const activeTabId = findTabIdBySessionId(useLayoutTreeStore.getState().tree.root, sessionId);
  if (activeTabId) {
    useLayoutTreeStore.getState().activateTab(targetLeafId, activeTabId);
  }
  useWorkspaceShellStore.getState().focusLeaf(targetLeafId);
  useSessionStore.getState().setActiveSessionId(sessionId);
}
```

---

# 六、 全链路重构代码落地蓝图

## 6.1 改造 `sessionTabDropCommit.ts`

升级 [`sessionTabDropCommit.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/shell/sessionTabDropCommit.ts)，接入三 Store 协同提交流程：

```typescript
// apps/crish-desktop/src/components/shell/sessionTabDropCommit.ts

import { useLayoutTreeStore, findNodeById, collectLeaves } from '../../store/layout-tree';
import { useWorkspaceShellStore } from '../../store/workspace-shell/workspaceShellStore';
import { useSessionStore } from '../../store/sessionStore';
import type { PaneDropRegion } from './sessionTabDragFeel';

export type SessionTabDropTarget =
  | { kind: 'strip'; targetLeafId: string; insertIdx: number }
  | { kind: 'pane'; targetLeafId: string; region: PaneDropRegion };

/**
 * 侧栏会话拖入右侧工作区落点提交器（支持直接分屏或在顶栏任意位置自由插入）
 */
export function commitSidebarSessionDrop(input: {
  sessionId: string;
  target: SessionTabDropTarget;
}): void {
  const { sessionId, target } = input;
  if (!sessionId) return;

  const shell = useWorkspaceShellStore.getState();

  if (target.kind === 'strip') {
    // 顶栏指定下标插入与激活
    shell.openOrFocusSession(sessionId, {
      activeLeafId: target.targetLeafId,
      insertIdx: target.insertIdx,
    });
    return;
  }

  if (target.region === 'center') {
    // 中心合并追加至末尾
    shell.openOrFocusSession(sessionId, {
      activeLeafId: target.targetLeafId,
    });
    return;
  }

  // 边缘分屏：走 workspaceShell 门面触发二叉树切分 + 焦点原子同步
  shell.splitSessionFromSidebar(sessionId, target.targetLeafId, target.region);
}
```

---

## 6.2 改造 `workspaceShellStore.ts` 与 `treeSessionCommands.ts`

在 [`workspaceShellStore.ts`](file:///c:/Software/conex/apps/crish-desktop/src/store/workspace-shell/workspaceShellStore.ts) 中补齐 `splitSessionFromSidebar` 与带 `insertIdx` 的 `openOrFocusSession`：

```typescript
// apps/crish-desktop/src/store/workspace-shell/workspaceShellStore.ts

  openOrFocusSession: (sessionId, opts) => {
    const sid = (sessionId || '').trim();
    if (!sid || isPendingDraft(sid)) return;

    const title = resolveSessionTabTitle(sid, opts?.title);
    const workspaceKey =
      canonicalSessionFolder(opts?.workspaceKey) ||
      sessionFromStore(sid)?.folder ||
      workspaceKeyNow() ||
      GENERAL_FOLDER;

    const targetLeaf = opts?.activeLeafId
      ? { id: opts.activeLeafId }
      : resolveActiveChatLeaf(get().lastChatLeafId);

    const result = treeOpenSession(sid, {
      title,
      workspaceKey,
      activeLeafId: targetLeaf.id,
      insertIdx: opts?.insertIdx, // 支持指定下标
    });

    if (opts?.split && result.created) {
      treeSplitTab(result.leafId, result.tabId, result.leafId, opts.split);
    }

    rememberChatLeaf(set, result.leafId);
    useSessionStore.getState().setActiveSessionId(sid);
  },

  splitSessionFromSidebar: (sessionId, dstLeafId, region) => {
    const sid = (sessionId || '').trim();
    if (!sid || isPendingDraft(sid) || !dstLeafId) return;

    const treeStore = useLayoutTreeStore.getState();
    treeStore.splitSessionFromSidebar(sid, dstLeafId, region);

    // 抓取切分后包含该 session 的实际全新叶子
    const updatedTree = useLayoutTreeStore.getState().tree;
    const leaves = collectLeaves(updatedTree.root);
    const fresh = leaves.find((l) => l.tabs.some((t) => t.sessionId === sid));
    const finalLeafId = fresh ? fresh.id : dstLeafId;

    // 原子同步至领域层与门面
    rememberChatLeaf(set, finalLeafId);
    useSessionStore.getState().setActiveSessionId(sid);
    syncSessionFromActiveLeaf(finalLeafId);
  },
```

---

## 6.3 改造 `layoutTreeInsert.ts` 与 `layoutTreeStore.ts`

升级 [`layoutTreeInsert.ts`](file:///c:/Software/conex/apps/crish-desktop/src/store/layout-tree/layoutTreeInsert.ts#L114) 的 `openSession` 操作，使其透传 `insertIdx` 至 `insertTab`：

```typescript
// apps/crish-desktop/src/store/layout-tree/layoutTreeInsert.ts

export function openSession(
  tree: LayoutTree,
  sessionId: string,
  opts: {
    title?: string;
    workspaceKey?: string;
    activeLeafId: string;
    insertIdx?: number; // 增加 insertIdx
  }
): { tree: LayoutTree; leafId: string; tabId: string; created: boolean } {
  // 1. 若全树已存在该 session: 执行 moveTab 搬移至指定 leaf 的指定 insertIdx
  const allLeaves = collectLeaves(tree.root);
  for (const leaf of allLeaves) {
    const existing = leaf.tabs.find((t) => t.sessionId === sessionId);
    if (existing) {
      if (leaf.id === opts.activeLeafId && opts.insertIdx !== undefined) {
        const movedTree = moveTab(tree, leaf.id, existing.tabId, leaf.id, opts.insertIdx);
        return { tree: movedTree, leafId: leaf.id, tabId: existing.tabId, created: false };
      }
      if (leaf.id !== opts.activeLeafId) {
        const movedTree = moveTab(
          tree,
          leaf.id,
          existing.tabId,
          opts.activeLeafId,
          opts.insertIdx ?? 0
        );
        return { tree: movedTree, leafId: opts.activeLeafId, tabId: existing.tabId, created: false };
      }
      return { tree, leafId: leaf.id, tabId: existing.tabId, created: false };
    }
  }

  // 2. 全树未存在: 创建并在 insertIdx 插入
  const newTab = createSessionTab({
    tabId: generateNodeId('tab'),
    sessionId,
    title: opts.title,
    workspaceKey: opts.workspaceKey,
  });

  const nextTree = insertTab(tree, opts.activeLeafId, newTab, opts.insertIdx);
  return { tree: nextTree, leafId: opts.activeLeafId, tabId: newTab.tabId, created: true };
}
```

---

## 6.4 改造 `useSessionListDrag.ts`

在 [`useSessionListDrag.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/useSessionListDrag.ts) 中装配 TabStrip 顶栏让位动力学：

```typescript
// 顶栏 Tab 动力学状态缓存
let currentStripEl: HTMLElement | null = null;
let currentStripTabs: CollectedStripData | null = null;
let currentStripInsertIdx = 0;

// 在 applyPointer 中：
if (target.domain === 'tab-strip') {
  hideIndicator();
  if (ghostEl) ghostEl.style.opacity = '0.95';

  const strip = target.stripEl;
  if (currentStripEl !== strip) {
    leaveStrip(currentStripEl);
    currentStripEl = strip;
    currentStripTabs = null;
  }

  if (!currentStripTabs) {
    currentStripTabs = collectStripTabs(strip, '', 'data-tab-id');
  }

  const insertIdx = computeSessionTabInsertIndex(currentStripTabs.tabs, clientX, dx);
  currentStripInsertIdx = insertIdx;

  const offsets = computeStripTabOffsets({
    tabCount: currentStripTabs.tabs.length,
    sourceIndex: null, // 跨域拖入，目标条中无源项占位
    insertIndex: insertIdx,
    shiftPx: 154,
  });

  shiftStripTabs(currentStripTabs.tabs, offsets);
} else {
  if (currentStripEl) {
    leaveStrip(currentStripEl);
    currentStripEl = null;
    currentStripTabs = null;
  }
}
```

---

## 6.5 改造 `crossDomainDropRouter.ts`

升级 [`crossDomainDropRouter.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/shell/drag-engine/crossDomainDropRouter.ts#L61-L67)，精准返回命中的 TabStrip 容器引用：

```typescript
// 顶栏 TabStrip 探测
const toolStrip = hit.closest('[data-leaf-tool-tab-strip]');
const stripWrap = !toolStrip ? (hit.closest('[data-pane-header="true"]') as HTMLElement | null) : null;
const tabStrip = stripWrap ? (stripWrap.querySelector('[role="tablist"]') as HTMLElement | null) : null;

if (tabStrip && stripWrap) {
  const targetLeafId = stripWrap.closest('[data-leaf-id]')?.getAttribute('data-leaf-id') || '';
  if (targetLeafId) {
    return {
      domain: 'tab-strip',
      targetLeafId,
      stripEl: tabStrip,
      insertIndex: 0, // 由调用方依据 strip DOM 结合 clientX 实时解算
    };
  }
}
```

---

# 七、 五层立体验证模型与测试用例设计

依据 `AGENTS.md` §7.1，设计五层立体验证模型，保证方案交付零缺陷：

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              【 五层立体验证模型 (AGENTS.md §7.1) 】                           │
├─────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 第 5 层：架构纯洁性审计                                                                         │
│   • 验证所有会话切分与激活 100% 走 workspaceShellStore 单一真理通道，零底层直接篡改            │
│   • 验证顶栏 TabStrip 与侧栏会话项视觉 Token 100% 引用统一 SSOT 变量                            │
├─────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 第 4 层：现场实证验收 (Tauri MCP / 真实 UI 环境)                                                │
│   • 侧栏拖出会话到 Pane 边缘分屏：松手瞬间新窗格立即呈现内容且高亮，零手动点击                │
│   • 侧栏拖出会话到 Pane 顶栏：Tab 项平滑向右 translateX(+154px) 腾位，松手在指定下标精准插入   │
│   • 侧栏与顶栏标签高度严格同为 28px，圆角严格同为 8px，视觉比例浑然一体                        │
├─────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 第 3 层：系统规范守门 (Automated Linters & Contract Guards)                                     │
│   • npm run check:desktop 100% 通过                                                             │
│   • CSS 规则检查：禁止在 TabStrip 中出现 26px / 4px 等硬编码魔术数字                            │
├─────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 第 2 层：领域逻辑与状态转移测试 (Domain Unit & Integration Tests)                               │
│   • `sessionTabDropCommit.test.ts`：测试 `commitSidebarSessionDrop` 触发的三 Store 原子同步      │
│   • `layoutTreeInsert.test.ts`：测试 `openSession` 支持 `insertIdx` 的正向与反向排序用例         │
│   • `tabDragGeometry.test.ts`：测试 1D 水平滞后插值与 `computeStripTabOffsets` 阶跃位移         │
├─────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 第 1 层：静态契约底线                                                                           │
│   • npm run typecheck 全仓 100% 零编译类型报错                                                  │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 关键自动化测试用例集

```typescript
describe('Cross-Domain TabStrip Free Reorder & Focus Synchronization', () => {
  it('should atomically synchronize layoutTreeStore, workspaceShellStore, and sessionStore on sidebar split', () => {
    const { shell } = getCompositionRoot();
    const treeStore = useLayoutTreeStore.getState();
    const leafId = treeStore.activeLeafId!;

    shell.splitSessionFromSidebar('sess-new-123', leafId, 'right');

    const nextTree = useLayoutTreeStore.getState();
    const freshLeaf = collectLeaves(nextTree.tree.root).find(l =>
      l.tabs.some(t => t.sessionId === 'sess-new-123')
    );

    expect(freshLeaf).toBeDefined();
    expect(nextTree.activeLeafId).toBe(freshLeaf!.id);
    expect(shell.getState().lastChatLeafId).toBe(freshLeaf!.id);
    expect(useSessionStore.getState().activeSessionId).toBe('sess-new-123');
  });

  it('should insert session tab at exact index in target TabStrip with auto-focus', () => {
    const { shell } = getCompositionRoot();
    const treeStore = useLayoutTreeStore.getState();
    const targetLeafId = treeStore.activeLeafId!;

    // 假设目标叶已有 2 个 tabs: [tab0, tab1]
    shell.openOrFocusSession('sess-inserted-456', {
      activeLeafId: targetLeafId,
      insertIdx: 1, // 插入在 tab0 与 tab1 之间
    });

    const leaf = findNodeById(useLayoutTreeStore.getState().tree.root, targetLeafId);
    expect(leaf.tabs[1].sessionId).toBe('sess-inserted-456');
    expect(useSessionStore.getState().activeSessionId).toBe('sess-inserted-456');
  });

  it('should compute exact horizontal shift offsets without oscillation', () => {
    const offsets = computeStripTabOffsets({
      tabCount: 3,
      sourceIndex: null,
      insertIndex: 1,
      shiftPx: 154,
    });

    expect(offsets).toEqual([0, 154, 154]);
  });
});
```

---

本详案已完成深度设计与形式化建模，可直接作为实现阶段的权威落地蓝图！
