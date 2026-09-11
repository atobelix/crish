# 多分屏默认激活会话与零点击（Zero-Click）实时渲染架构方案

> **状态**：评审中（主 Agent 独立方案）
> **文档定位**：针对分屏窗口“默认显示空对话界面（我们在 conex 中处理什么？），只有点击之后才显示实际界面”的端到端根治方案。
> **架构契约**：遵守 `AGENTS.md` §1（反退避）、§7（严禁补丁与伪兼容）、§7.1（立体验证纪律）。

---

## 一、 现场病理与核心矛盾确证

### 1.1 现象对比与截图物证
根据用户在真实环境下的两张现场截图（`media_1788329382270.png` 与 `media_1788329406604.png`）：

1. **图 1（未点击前的僵死态）**：
   - 界面切分了 3 个分屏窗格（左上、右上、下方）；
   - 左上窗格顶栏已有 Tab：`你好，请简单回复...`；
   - 右上窗格顶栏已有 Tab：`你好啊，你是什...`；
   - 下方窗格顶栏已有 Tab：`运行 git status 与...` 和 `请回复一句话确认...`；
   - **然而 3 个窗格的内容区全部显示为 `ChatEmptyState` 欢迎面（“我们在 conex 中处理什么？”），顶层面包屑均退化为 `对话 / 新会话`，顶栏标签均未处于激活高亮态**。
2. **图 2（点击激活后的自愈态）**：
   - 用户分别用鼠标在 3 个窗口上各点击一下后：
     - 左上窗口瞬间显示出 `你好，请简单回复一句话确认链路正常` 的真实会话历史；
     - 右上窗口瞬间显示出 `你好啊，你是什模型呢` 与 Claude 回复；
     - 下方窗口瞬间显示出 `请回复一句话确认链路正常，不需要调用工具`；
   - **确凿结论**：会话数据早就在内存与底层 SQLite 数据库中完整就绪，没有任何丢失，也不存在网络加载延迟；纯粹是因为界面在未被点击前，窗格的状态机被错误地置于了“新对话草稿空态”！

---

## 二、 全链路代码白盒诊断与 4 大根因

### 2.1 根因一：`sessionTabMigration` 历史遗留的“保留无选中”毒瘤
在 `apps/crish-desktop/src/store/layout-tree/sessionTabMigration.ts` 中：
```typescript
// sessionTabMigration.ts:534-536
} else if (!leaf.activeTabId && leaf.tabs.length > 0) {
  /* 已是新对话界面，保留无选中 */
}
```
以及 `finalizeLeaf` 中的回退逻辑：
```typescript
// sessionTabMigration.ts:256-258
const activeTabId = tabs.some((t) => t.tabId === leaf.activeTabId)
  ? leaf.activeTabId
  : '';
```
- **病理剖析**：代码作者存在一个错误的教条假设——“只要 `leaf.activeTabId` 为空，即使它拥有真实会话 Tab，也代表用户正在该窗口撰写新对话草稿，应该保留无选中”。
- **连锁破坏**：在冷启动水合（`hydrateWorkspaceShell`）或树迁移阶段，一旦任何叶子的 `activeTabId` 丢失或未能精确匹配，系统没有智能回退到该叶子的第一个会话 Tab（`tabs[0].tabId`），而是直接将其重置为空字符串 `''`！

---

### 2.2 根因二：`TreeLeafPanel` 的 `readActiveTab` 判定单向断裂
在 `apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx` 中：
```typescript
function readActiveTabId(leaf: LayoutLeaf): string {
  const id = (leaf as LayoutLeaf & { activeTabId?: string }).activeTabId;
  return typeof id === 'string' ? id : '';
}

function readActiveTab(leaf: LayoutLeaf): LeafSessionTab | undefined {
  const tabs = readLeafTabs(leaf);
  const activeTabId = readActiveTabId(leaf);
  if (!activeTabId) return undefined;
  return tabs.find((t) => t.tabId === activeTabId);
}
```
进而驱动了会话 ID 的派生：
```typescript
// TreeLeafPanel.tsx:153-156
const activeTab = readActiveTab(leaf);
const sessionForPanel = activeTab?.sessionId || mintDraftSessionId(leaf.id);
```
- **病理剖析**：
  1. 当 `activeTabId === ''` 时，即使 `leaf.tabs` 里有 5 个已经加载完成的真实会话，`readActiveTab` 依然硬编码直接返回 `undefined`！
  2. 此时 `sessionForPanel` 只能被迫走 `||` 右侧的 fallback：`mintDraftSessionId(leaf.id)`（生成一个形如 `__pending_draft__leaf-xxx` 的全新虚拟草稿 ID）；
  3. `UnitChromeActions` 收到 `sessionForPanel`，检测到是 `isPendingDraft`，面包屑立即显示为 `对话 / 新会话`；
  4. `ChatCard` 收到该草稿 ID，在 `sessionStore.sessionsById` 中完全查不到消息（消息数为 0），`useChatEmptyKind` 判定为 `session-empty`，渲染“我们在 conex 中处理什么？”欢迎面；
  5. 顶栏 `PaneHeader` 循环渲染 `leaf.tabs` 时，因 `tab.tabId === activeTabId`（`tabId === ''`）永不成立，所有 Tab 都处于未激活的灰色状态！

---

### 2.3 根因三：多窗口生命周期中对“点击唤醒（Click-to-Wake）”的单向依赖
在 `TreeLeafPanel.tsx:161-180` 中：
```typescript
const handleActivate = useCallback(
  (e?: React.PointerEvent) => {
    ...
    const tabId = readActiveTabId(leaf);
    if (tabId) {
      sessionShell().activateTab(leaf.id, tabId);
    } else {
      getCompositionRoot().shell.focusLeaf(leaf.id);
    }
  },
  [leaf]
);
```
- **病理剖析**：
  - 用户用鼠标点击窗口时，触发了 `handleActivate` 或 Tab 点击 `sessionShell().activateTab`；
  - 只有在点击事件发生后，系统才执行 `treeActivateTab`，将 `leaf.activeTabId` 设置为某个 Tab 的实际 ID；
  - 此时 `readActiveTab` 终于不是 `undefined`，`sessionForPanel` 终于变成了真实的 `sessionId`，组件重新渲染，真实消息流这才“被动苏醒”！
  - **这违背了现代 GUI 的“所见即所得”基本准则**：后台窗格即使没有操作系统级焦点（Focus），其内部也必须以只读形式正常渲染当前标签内容，绝不能要求用户“挨个点击一遍才能看内容”。

---

### 2.4 根因四：拖拽分屏（Split Screen）时的叶子节点状态机同步遗漏
虽然我们在上一轮重构中补全了 `splitSessionFromSidebar` 对新建叶节点 `freshLeaf.activeTabId = newTab.tabId` 的设置，但在以下两种分屏场景中仍存在盲区：
1. **源窗格（Source Leaf）的 Tab 被移出后**：若源窗格原本激活的 Tab 被拖走，源窗格降级激活邻居 Tab 时，如果未同步通知到视图层或 `activeTabId` 未落盘，源窗格会在分屏后瞬间退化为空白态；
2. **多窗格冷启动恢复（Hydrate Workspace）**：当用户在多窗格状态下关闭软件或刷新页面，冷启动恢复时仅还原了二叉树几何，未对所有叶子的 `activeTabId` 进行自愈校验，导致除了主叶外，其余叶子均在第一帧处于未激活盲区。

---

## 三、 架构重构与不变量体系（SSOT）

为了彻底根治这一问题，杜绝任何打补丁（如在 `useEffect` 里加 `setTimeout` 点击触发）的恶劣行径，方案确立 **4 大架构不变量（System Invariants）**：

### 3.1 不变量 1：有 Tab 必有激活（No Orphan Tabs Invariant）
> **定义**：对于任意 Chat 叶节点 $L$，若 $L.tabs.length > 0$，则必须满足：
> $$ \exists t \in L.tabs, \quad t.tabId = L.activeTabId $$
> 若当前 $L.activeTabId$ 为空字符串 `''` 或指向已不存在的 Tab，**树状态机与渲染层必须无条件以首个 Tab（$L.tabs[0].tabId$）作为默认激活项**。任何阶段禁止出现“叶子有真实 Tab，但处于无选中草稿态”的非法状态。

### 3.2 不变量 2：草稿态（Draft Mode）严格显式触发
> **定义**：一个叶节点 $L$ 处于新会话草稿态（`activeTabId === ''` 且展示欢迎面）的**唯一合法场景**是：
> 1. $L.tabs.length === 0$（真正的空叶）；
> 2. 用户在顶栏**显式点击了加号（`+`）按钮**，意图明确要在该叶发起全新的未命名对话。
> 除此之外，任何数据迁移、分屏切分、窗口挂载均不得使包含有效会话的叶节点沦为草稿态。

### 3.3 不变量 3：窗格渲染作用域绝对单一真理源（Per-Leaf Scoped SSOT）
> **定义**：每个 `TreeLeafPanel` 的内容渲染仅取决于本叶所绑定的会话（$L.activeTab.sessionId$），与该窗格当前是否处于全局主聚焦（`isActive`）完全正交。非主聚焦的窗格必须完整、正确、静态地渲染其自身标签对应的消息列表，零闪烁、零空屏。

### 3.4 不变量 4：冷启动首帧自愈闭环（Zero-Click Hydration）
> **定义**：在 `hydrateWorkspaceShell` 执行完毕的当轮事件循环内，整棵二叉树的所有叶节点完成自愈校验，向渲染层提交的状态即为全部 Tab 绑定的完整终态。首帧绘制即呈现各窗口的真实对话内容。

---

## 四、 具体落地实施细节

### 4.1 核心修补点 1：`TreeLeafPanel` 渲染层自愈防线（双重保险）
修改 `apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx`：
```typescript
function readActiveTab(leaf: LayoutLeaf): LeafSessionTab | undefined {
  const tabs = readLeafTabs(leaf);
  if (tabs.length === 0) return undefined;

  const activeTabId = readActiveTabId(leaf);
  // 1. 若 activeTabId 有效且命中某 Tab，直接返回
  if (activeTabId) {
    const found = tabs.find((t) => t.tabId === activeTabId);
    if (found) return found;
  }

  // 2. 核心架构自愈：若有真实 tabs 但 activeTabId 为空或失效，
  //    默认回退到第一个已存在的会话 Tab，绝对严禁让拥有会话的窗口退化为草稿空屏！
  return tabs[0];
}
```
**效果**：即使底层数据层传入了带有历史瑕疵的 `activeTabId = ''`，视图层也绝不退化为 `mintDraftSessionId`，而是立即、平滑、开箱即用地渲染第一个 Tab 的真实历史！

---

### 4.2 核心修补点 2：根除 `sessionTabMigration.ts` 的保留无选中逻辑
修改 `apps/crish-desktop/src/store/layout-tree/sessionTabMigration.ts`：
1. 在 `finalizeLeaf` 中：
```typescript
function finalizeLeaf(leaf: WorkLeaf): LayoutLeaf {
  const tabs = leaf.tabs.filter((t) => isRealSessionId(t.sessionId));
  // 刚性收敛：如果未设置 activeTabId 或未命中，回退到首个真实 Tab
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
2. 在 S7 迁移校验中：
彻底删除 `/* 已是新对话界面，保留无选中 */` 分支，统一收敛为：
```typescript
// S7：activeTabId 校正
for (const leaf of chatLeaves()) {
  const prefer = leaf.legacySid
    ? leaf.tabs.find((t) => t.sessionId === leaf.legacySid)
    : undefined;
  if (prefer) {
    leaf.activeTabId = prefer.tabId;
  } else if (!leaf.tabs.some((t) => t.tabId === leaf.activeTabId)) {
    // 无论 activeTabId 是否为空，只要 tabs 有项，就必须默认激活第 0 个 Tab
    leaf.activeTabId = leaf.tabs[0]?.tabId ?? '';
  }
  leaf.panelId = 'chat';
}
```

---

### 4.3 核心修补点 3：冷启动水合自愈门闩（`hydrateWorkspaceShell.ts`）
在 `apps/crish-desktop/src/app/hydrateWorkspaceShell.ts` 中：
水合迁移结束后，显式执行一次全树叶子校正，并同步三 Store：
```typescript
// 校验所有 chat 叶节点：凡是有 tabs 的叶子，若 activeTabId 为空则自愈为 tabs[0].tabId
const currentTree = treeStore.tree;
let modified = false;
const leaves = collectLeaves(currentTree.root);
for (const leaf of leaves) {
  if (leaf.tabs.length > 0 && !leaf.activeTabId) {
    leaf.activeTabId = leaf.tabs[0]!.tabId;
    modified = true;
  }
}
if (modified) {
  treeStore.setTree({ ...currentTree });
}

// 确保主叶激活项与全局 session 同步
const activeLeaf = resolveActiveChatLeaf(treeStore.activeLeafId);
if (activeLeaf && activeLeaf.activeTabId) {
  const activeTab = activeLeaf.tabs.find((t) => t.tabId === activeLeaf.activeTabId);
  if (activeTab && isRealSessionId(activeTab.sessionId)) {
    root.session.setActiveSessionId(activeTab.sessionId);
    root.shell.rememberChatLeaf(activeLeaf.id);
  }
}
```

---

### 4.4 核心修补点 4：`PaneHeader` 标签项高亮同步
修改 `apps/crish-desktop/src/components/binary-tree/PaneHeader.tsx`：
由于 `readActiveTab` 进行了智能自愈，`PaneHeader` 中：
```typescript
const effectiveActiveTabId = activeTabId || visibleTabs[0]?.tabId || '';
```
确保顶栏渲染时，不仅内容区呈现真实对话，顶栏对应的首个标签也呈现高亮激活背景（白色卡片胶囊），彻底消灭标签与内容区状态撕裂的违和感。

---

## 五、 立体验证计划（Verification & Test Matrix）

严格遵守 `AGENTS.md` §7.1，编写针对性的回归自动化测试：

1. **单元测试：`treeLeafDefaultActive.test.tsx`**：
   - 场景 A：构造拥有 2 个 Tab 但 `activeTabId === ''` 的叶节点挂载到 `TreeLeafPanel`，断言 `sessionForPanel` 自动收敛到 `tabs[0].sessionId`，内容区挂载 `ChatMessageList`，绝不挂载 `ChatEmptyState`；
   - 场景 B：断言面包屑 `UnitChromeActions` 呈现真实的会话标题与项目名，绝不退化为 `对话 / 新会话`；
   - 场景 C：断言顶栏 `PaneHeader` 的第 0 个 Tab 自动附加 `tabItemActive` 样式类；
   - 场景 D：真正拥有 0 个 Tab 的叶节点，验证其正常回退到草稿态 `mintDraftSessionId`，正确展示欢迎面（保护合法新会话逻辑）。
2. **迁移契约测试：`sessionTabMigration.test.ts`**：
   - 输入包含 tabs 但无 activeTabId 的树结构，断言迁移输出的 `activeTabId === tabs[0].tabId`，证明“保留无选中”毒瘤被彻底铲除。
3. **全量回归门禁**：
   - `npm run typecheck` 100% 零错误；
   - 运行全部 11 大核心测试套件，保证 161+ 测试绿灯全通。

---

## 六、 结论与落地建议

本方案从根本上摒弃了历史代码中“必须点击才能唤醒窗口”的落后设计，在**数据层迁移、树状态机、渲染层降级、冷启动水合**4 个关键卡点上构筑了刚性不变量。一旦落地，客户端在任何分屏、重启、多会话场景下均将展现出完全自然、即时、所见即所得的顶级交互体验。
