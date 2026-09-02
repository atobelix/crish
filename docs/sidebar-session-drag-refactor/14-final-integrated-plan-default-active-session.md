# 多分屏默认激活会话与零点击（Zero-Click）实时呈现终极融合详案

> **状态**：已锁定（主子 Agent 联合融合最终案）  
> **文档归属**：`docs/sidebar-session-drag-refactor/14-final-integrated-plan-default-active-session.md`  
> **前序方案**：
> - 子 Agent 详案：[`docs/sidebar-session-drag-refactor/12-sub-agent-default-active-session-plan.md`](./12-sub-agent-default-active-session-plan.md)
> - 主 Agent 详案：[`docs/sidebar-session-drag-refactor/13-main-agent-default-active-session-plan.md`](./13-main-agent-default-active-session-plan.md)  
> **纪律准绳**：严格执行 `AGENTS.md` §1（反退避）、§7（严禁打补丁与伪兼容）、§7.1（立体验证纪律）。

---

## 一、 现场病理与核心矛盾确证

### 1.1 两张现场截图物理铁证
用户在真实运行环境中提交的两张物理截图（`media_1788329382270.png` 与 `media_1788329406604.png`）揭示了明确的病理：

```
【 截图 1（点击前）】
┌─────────────────────────────────┬─────────────────────────────────┐
│ [你好，请简单回复...]            │ [你好啊，你是什...]              │  <-- 顶栏 Tab 真实存在，但呈暗灰未激活
│ 对话 / 新会话                   │ 对话 / 新会话                   │  <-- 面包屑全部退化为草稿默认值
│                                 │                                 │
│   我们在 conex 中处理什么？      │   我们在 conex 中处理什么？      │  <-- 内容区全部渲染为 ChatEmptyState
│   [分析项目结构] [查看代码改动]  │   [分析项目结构] [查看代码改动]  │
└─────────────────────────────────┴─────────────────────────────────┘
┌───────────────────────────────────────────────────────────────────┐
│ [运行 git status 与...] [请回复一句话确认...]                      │
│ 对话 / 新会话                                                     │  <-- 下方窗口同样渲染为新会话草稿态
│   我们在 conex 中处理什么？                                       │
└───────────────────────────────────────────────────────────────────┘

                          ▼ 用户鼠标在各窗口分别点击一下

【 截图 2（点击后）】
┌─────────────────────────────────┬─────────────────────────────────┐
│ [你好，请简单回复...] (高亮白)   │ [你好啊，你是什...] (高亮白)     │  <-- 顶栏 Tab 正常呈现白色胶囊高亮
│ conex / 你好，请简单回复一句话...│ conex / 你好啊，你是什模型呢     │  <-- 面包屑呈现真实项目与会话标题
│                                 │                                 │
│ User: 你好，请简单回复一句话确认│ User: 你好啊，你是什模型呢       │  <-- 真实历史消息原样实时上屏！
│ Assistant: (上次回复未完成)     │ Assistant: 我是 Claude...       │      （无需拉取任何网络与 IPC）
└─────────────────────────────────┴─────────────────────────────────┘
┌───────────────────────────────────────────────────────────────────┐
│ [运行 git status 与...] [请回复一句话确认...] (高亮白)             │
│ 对话 / 请回复一句话确认链路正常...                                │
│ User: 请回复一句话确认链路正常，不需要调用工具                     │
└───────────────────────────────────────────────────────────────────┘
```

### 1.2 关键确凿事实
1. **数据零丢失、零网络延迟**：会话及其消息早已在软件启动反序列化时完整水合进入 Zustand 内存 `sessionStore.sessionsById`，底层 SQLite 数据毫无缺失。点击瞬间内容立刻呈现，证明没有任何异步加载或 IPC 延迟；
2. **纯粹是状态机主动降级为草稿态**：在用户未点击该窗口前，窗口的状态机被错误地赋予或判定成了 `activeTabId === ''`，进而强制降级为虚拟草稿会话（`__pending_draft__leaf-xxx`），强行渲染了新会话欢迎页。

---

## 二、 白盒全链路诊断与 4 大根因断层

### 2.1 根因一：数据迁移与水合中人为保留“无选中”的伪逻辑
在 [`apps/crish-desktop/src/store/layout-tree/sessionTabMigration.ts:534-536`](file:///c:/Software/conex/apps/crish-desktop/src/store/layout-tree/sessionTabMigration.ts#L534-L536)：
```typescript
} else if (!leaf.activeTabId && leaf.tabs.length > 0) {
  /* 已是新对话界面，保留无选中 */
}
```
以及 `finalizeLeaf` 中的强制回退：
```typescript
// sessionTabMigration.ts:256-258
const activeTabId = tabs.some((t) => t.tabId === leaf.activeTabId)
  ? leaf.activeTabId
  : '';
```
- **病理解码**：历史代码中充斥着“若没有 activeTabId，即使有 tabs 也是新会话”的错误假设。导致在冷启动恢复、树反序列化迁移或节点标准化时，一旦 `activeTabId` 为空或不匹配，系统直接将其置为空串 `''`，任由拥有会话的叶子处于无选中瘫痪态。

### 2.2 根因二：`TreeLeafPanel` 的 `readActiveTab` 判定单向击穿
在 [`apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx:97-102`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx#L97-L102)：
```typescript
function readActiveTab(leaf: LayoutLeaf): LeafSessionTab | undefined {
  const tabs = readLeafTabs(leaf);
  const activeTabId = readActiveTabId(leaf);
  if (!activeTabId) return undefined;
  return tabs.find((t) => t.tabId === activeTabId);
}
```
结合：
```typescript
// TreeLeafPanel.tsx:153-156
const activeTab = readActiveTab(leaf);
const sessionForPanel = activeTab?.sessionId || mintDraftSessionId(leaf.id);
```
- **病理解码**：
  1. 当 `activeTabId === ''` 时，`readActiveTab` 直接返回 `undefined`；
  2. `sessionForPanel` 只能走 fallback：`mintDraftSessionId(leaf.id)`（生成一个全新的临时草稿 ID `__pending_draft__leaf-xxx`）；
  3. `UnitChromeActions` 收到草稿 ID，触发 `isDraft = true`，一级面包屑退化为 `"对话"`，二级标题退化为 `"新会话"`；
  4. `ChatCard` 收到草稿 ID，在 `sessionsById` 中查不到任何消息（`messageCount = 0`），直接展示欢迎页；
  5. 顶栏 `PaneHeader` 因 `tab.tabId !== activeTabId`（`activeTabId` 是空串），所有 Tab 呈暗灰未激活状态。

### 2.3 根因三：持久化门禁漏洞（`layoutRestorePolicy.ts`）
在 [`apps/crish-desktop/src/store/layout-tree/layoutRestorePolicy.ts:107`](file:///c:/Software/conex/apps/crish-desktop/src/store/layout-tree/layoutRestorePolicy.ts#L107)：
```typescript
if (leaf.activeTabId && !leaf.tabs.some((t) => t.tabId === leaf.activeTabId)) {
  return false;
}
```
- **病理解码**：门禁只对**非空**的 `activeTabId` 进行合法性校验！当 `leaf.activeTabId === ''` 且 `leaf.tabs.length > 0` 时，门禁直接判定为 `true`（合法通过）！使得破损的“有 Tab 却无激活”的残疾状态作为合法树写入 LocalStorage 与内存，并在冷启动时原封不动复活！

### 2.4 根因四：多窗口生命周期对“点击唤醒（Click-to-Wake）”的单向依赖
- 在 [`TreeLeafPanel.tsx:161-180`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx#L161-L180)：
  只有用户点击窗格内部或点击某个 Tab 时，才触发 `handleActivate` $\to$ `sessionShell().activateTab`，从而将真实 `tabId` 写入 `activeTabId`；
- **现代 GUI 铁律断裂**：后台窗格哪怕没有获得操作系统焦点，也必须完整渲染自身绑定的标签会话，绝不能逼迫用户“挨个点击一遍才能看内容”。

---

## 三、 架构公理与系统不变量体系（SSOT）

本方案融合主子 Agent 设计精华，确立**数学代数公理**与**四大系统生命周期不变量**：

### 3.1 代数不变量公理（Leaf Tab Invariant Axiom）
$$\forall \text{leaf} \in \text{ChatLeaves}, \quad \text{leaf.tabs} \ne \emptyset \iff \exists ! \, t \in \text{leaf.tabs} \text{ s.t. } t.\text{tabId} = \text{leaf.activeTabId}$$
- **推论**：对于任意拥有会话 Tab 的窗格，`activeTabId` 绝对不允许为空字符串 `''`！一旦检测到失配，必须立即且唯一地收敛至首个真实 Tab（`leaf.tabs[0].tabId`）。

### 3.2 四大生命周期不变量
1. **不变量 1：有 Tab 必有激活（No Orphan Tabs）**：任何阶段（水合、迁移、分屏切分、渲染）禁止产生“包含有效 Tab 但未激活任何 Tab”的叶节点；
2. **不变量 2：草稿态严格显式触发（Explicit Draft Only）**：一个 Leaf 处于新会话草稿态的充分必要条件是：
   - 条件 A：$L.tabs.length === 0$（真正无会话的空叶）；
   - 条件 B：用户在顶栏**显式点击加号（`+`）按钮**，表达明确的新建对话意图。除此之外任何场景不得将包含 Tab 的叶子置为草稿态；
3. **不变量 3：窗格渲染与全局主聚焦绝对正交（Orthogonal Multi-Pane Rendering）**：每个 `TreeLeafPanel` 的内容渲染仅取决于本叶所绑定的会话，与该窗格当前是否处于全局 `isActive` 完全正交，非主聚焦窗格无条件全保真渲染；
4. **不变量 4：首帧自愈闭环（Zero-Click Hydration）**：客户端启动水合第一帧即完成全树叶子校正并与全局 Session 对齐，零点击直接呈现真实对话。

---

## 四、 三道立体自愈防线实施详案

```
               【 第一道防线：数据入口与持久化门禁 】
               sessionTabMigration.ts (清除保留无选中)
               layoutRestorePolicy.ts (刚性拦截非法空激活)
                                 │
                                 ▼
               【 第二道防线：运行时状态机与分屏切分 】
               layoutTreeInsert.ts (规范 enterComposer)
               workspaceShellStore.ts (focusLeaf 与分屏原子同步)
               sessionTabDropCommit.ts (跨 Leaf 切分原子对齐)
                                 │
                                 ▼
               【 第三道防线：视图呈现纯函数自愈兜底 】
               TreeLeafPanel.tsx (readActiveTab 兜底回退 tabs[0])
               PaneHeader.tsx (effectiveActiveTabId 高亮同步)
               hydrateWorkspaceShell.ts (冷启动活动叶对齐)
```

### 4.1 第一道防线：数据入口与持久化门禁

#### 1. 修改 `apps/crish-desktop/src/store/layout-tree/sessionTabMigration.ts`
- **修改点 A (`finalizeLeaf`)**：
  ```typescript
  function finalizeLeaf(leaf: WorkLeaf): LayoutLeaf {
    const tabs = leaf.tabs.filter((t) => isRealSessionId(t.sessionId));
    // 刚性收敛：若 tabs 有项，activeTabId 必须有效，否则强制回退 tabs[0]
    const activeTabId = tabs.some((t) => t.tabId === leaf.activeTabId)
      ? leaf.activeTabId
      : (tabs[0]?.tabId ?? '');
    return {
      type: 'leaf',
      id: leaf.id,
      panelId: 'chat',
      tabs,
      activeTabId,
      dock: createDefaultDock(),
    };
  }
  ```
- **修改点 B (S7 校验)**：彻底删除第 534 行 `/* 已是新对话界面，保留无选中 */`：
  ```typescript
  for (const leaf of chatLeaves()) {
    const prefer = leaf.legacySid
      ? leaf.tabs.find((t) => t.sessionId === leaf.legacySid)
      : undefined;
    if (prefer) {
      leaf.activeTabId = prefer.tabId;
    } else if (!leaf.tabs.some((t) => t.tabId === leaf.activeTabId)) {
      leaf.activeTabId = leaf.tabs[0]?.tabId ?? '';
    }
    leaf.panelId = 'chat';
  }
  ```

#### 2. 修改 `apps/crish-desktop/src/store/layout-tree/layoutRestorePolicy.ts`
- **加严门禁**：拦截包含 Tab 但未设置 `activeTabId` 的坏态结构：
  ```typescript
  // layoutRestorePolicy.ts:106-112
  if (leaf.tabs.length > 0) {
    if (!leaf.activeTabId || !leaf.tabs.some((t) => t.tabId === leaf.activeTabId)) {
      return false; // 刚性拒绝无选中的非法坏态，促发全量自愈迁移
    }
  } else if (leaf.activeTabId !== '') {
    return false;
  }
  ```

---

### 4.2 第二道防线：运行时状态机与分屏切分

#### 3. 修改 `apps/crish-desktop/src/store/layout-tree/layoutTreeInsert.ts`
- **规范 `enterComposer`**：仅在用户显式要求新建草稿时允许 `activeTabId = ''`，分屏创建与 Tab 插入必须保持有效激活：
  ```typescript
  // layoutTreeInsert.ts splitTab 内部
  const fresh: LayoutLeaf = {
    type: 'leaf',
    id: generateNodeId('leaf'),
    panelId: 'chat',
    tabs: [tab],
    activeTabId: tab.tabId, // 刚性赋予激活
    dock: createDefaultDock(),
  };
  ```

#### 4. 修改 `apps/crish-desktop/src/store/workspace-shell/workspaceShellStore.ts`
- **强化 `focusLeaf`**：被聚焦的叶子若 `activeTabId` 丢失但有 Tab，主动纠正激活首个 Tab：
  ```typescript
  focusLeaf: (leafId) => {
    const chats = ownedChatLeaves(useLayoutTreeStore.getState().tree.root);
    const leaf = chats.find((l) => l.id === leafId);
    if (!leaf) return;
    const targetTabId = leaf.activeTabId || leaf.tabs[0]?.tabId;
    if (targetTabId) {
      treeActivateTab(leafId, targetTabId);
    } else {
      useLayoutTreeStore.getState().setActiveLeaf(leafId);
    }
    rememberChatLeaf(set, leafId);
    syncSessionFromActiveLeaf(leafId);
  },
  ```

#### 5. 修改 `apps/crish-desktop/src/components/shell/sessionTabDropCommit.ts`
- 跨 Leaf 拖拽分屏后，调用 `sessionShell().activateTab` 保证新建窗格或目标窗格原子高亮并同步会话上下文。

---

### 4.3 第三道防线：视图呈现纯函数自愈兜底

#### 6. 修改 `apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx`
- **改造 `readActiveTab`**：纯函数级兜底，只要 `tabs.length > 0`，绝不返回 `undefined`：
  ```typescript
  function readActiveTab(leaf: LayoutLeaf): LeafSessionTab | undefined {
    const tabs = readLeafTabs(leaf);
    if (tabs.length === 0) return undefined;

    const activeTabId = readActiveTabId(leaf);
    if (activeTabId) {
      const match = tabs.find((t) => t.tabId === activeTabId);
      if (match) return match;
    }
    // 核心兜底：失配或为空时无条件回退到第一个 Tab，绝不沦为草稿态！
    return tabs[0];
  }
  ```
- **异步纠正 Store（自愈闭环）**：在渲染后利用微任务检查并纠正树中的 `leaf.activeTabId`，使 Store 状态与视图保持一致。

#### 7. 修改 `apps/crish-desktop/src/components/binary-tree/PaneHeader.tsx`
- **计算 `effectiveActiveTabId`**：
  ```typescript
  const effectiveActiveTabId = activeTabId || visibleTabs[0]?.tabId || '';
  ```
  Tab 循环渲染的激活样式判定改为：
  ```typescript
  const isSelected = tab.tabId === effectiveActiveTabId;
  ```
  确保首个 Tab 默认渲染白色卡片胶囊，消灭标签与内容区状态割裂。

#### 8. 修改 `apps/crish-desktop/src/app/hydrateWorkspaceShell.ts`
- **冷启动水合对齐**：水合结束后，对全树叶节点进行一次自愈扫描，并对当前活动 ChatLeaf 执行 `root.shell.activateTab`，首帧即对齐全局会话上下文。

---

## 五、 精确改动文件清单（共 7 个核心代码文件 + 1 个测试文件）

| 文件路径 | 职责与修改重点 |
| :--- | :--- |
| [`apps/crish-desktop/src/store/layout-tree/sessionTabMigration.ts`](file:///c:/Software/conex/apps/crish-desktop/src/store/layout-tree/sessionTabMigration.ts) | 根除 `/* 已是新对话界面，保留无选中 */`，`finalizeLeaf` 强制收敛有效激活。 |
| [`apps/crish-desktop/src/store/layout-tree/layoutRestorePolicy.ts`](file:///c:/Software/conex/apps/crish-desktop/src/store/layout-tree/layoutRestorePolicy.ts) | 门禁刚性拦截 `tabs.length > 0 && !activeTabId` 的坏态结构。 |
| [`apps/crish-desktop/src/store/layout-tree/layoutTreeInsert.ts`](file:///c:/Software/conex/apps/crish-desktop/src/store/layout-tree/layoutTreeInsert.ts) | 规范 `splitTab` 与 `enterComposer`，保障新窗格初始具有有效激活。 |
| [`apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx) | `readActiveTab` 纯函数兜底回退 `tabs[0]`，并异步回写纠正 Store。 |
| [`apps/crish-desktop/src/components/binary-tree/PaneHeader.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/PaneHeader.tsx) | 引入 `effectiveActiveTabId`，顶栏标签与内容区同步高亮。 |
| [`apps/crish-desktop/src/store/workspace-shell/workspaceShellStore.ts`](file:///c:/Software/conex/apps/crish-desktop/src/store/workspace-shell/workspaceShellStore.ts) | `focusLeaf` 激活未选叶子时自动选第 0 个 Tab，原子同步三 Store。 |
| [`apps/crish-desktop/src/app/hydrateWorkspaceShell.ts`](file:///c:/Software/conex/apps/crish-desktop/src/app/hydrateWorkspaceShell.ts) | 冷启动水合完成扫描全树叶节点自愈，同步全局会话。 |
| [`apps/crish-desktop/src/components/binary-tree/__tests__/treeLeafDefaultActive.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/__tests__/treeLeafDefaultActive.test.tsx) | **[新建]** 针对分屏默认激活与零点击渲染的五维立体自动化测试套件。 |

---

## 六、 立体验证矩阵（Test Matrix）

严格遵守 `AGENTS.md` §7.1 立体验证纪律，新增专项测试套件并运行全仓门禁：

1. **测试用例 1（零点击渲染直出）**：
   - 构造包含 2 个 Tab 但 `activeTabId === ''` 的叶子挂载 `TreeLeafPanel`；
   - 断言：`sessionForPanel` 自动收敛为 `tabs[0].sessionId`；内容区挂载 `ChatMessageList`，严禁挂载 `ChatEmptyState`；
2. **测试用例 2（面包屑真实展现）**：
   - 断言：`UnitChromeActions` 渲染出真实会话标题，绝不退化为 `对话 / 新会话`；
3. **测试用例 3（顶栏高亮同步）**：
   - 断言：`PaneHeader` 中的 `tabs[0]` 具有 `tabItemActive` 样式类，高亮显示；
4. **测试用例 4（合法草稿态不受影响）**：
   - 构造真正 `tabs.length === 0` 的空叶，验证其正常渲染 `mintDraftSessionId` 与欢迎面（保护合法新会话）；
5. **测试用例 5（迁移契约断言）**：
   - 输入包含 tabs 但无 activeTabId 的破损 JSON 树，验证 `migrateToLeafOwnedTabs` 输出的 `activeTabId === tabs[0].tabId`；
6. **门禁验证**：
   - `npm run typecheck` 100% 零错误；
   - 运行全部 12 大核心测试套件，确保 165+ 测试 100% 绿灯。
