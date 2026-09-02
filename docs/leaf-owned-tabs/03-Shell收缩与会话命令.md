# 03 — Shell 收缩与会话命令

> **战役**：`docs/leaf-owned-tabs/`  
> **总案**：`00-总方案.md`（口径权威）  
> **本维文件域（独占写）**：`workspaceShellStore.ts`、`workspace-shell/types.ts`、`leafBindingHelpers.ts`、`compositionRoot.ts`  
> **依赖**：维 01（`SessionTab` / `LayoutLeaf.tabs` / 迁移）+ 维 02（`activateTab` / `addTab` / `openSession` / `removeTab` / 空叶 prune）  
> **被依赖**：维 05（窗格 UI 只调本维门面）、维 07（删测试与死轨）

---

## 0. 采用总案 / 发现缺口

**采用总案**，不改所有权模型：

- `openTabs` / `activeTabId` 不再是写源；标签权威在 chat 叶 `tabs` + `activeTabId`。
- `openOrFocusSession` / `activateTab` / `closeTab` / `openNewDraftTab` = 找叶 + 调维 02 命令 + `setActiveSessionId`。
- 未打开会话加入**当前活动 chat 叶**的 `tabs`。禁止「偷活动叶 / 不 auto-split / unplaced 投影到条带」双语义。
- 草稿是叶子上的真 tab；关 tab ≠ 摘 Conversation Unit。

**总案未写、本维补上（不改效果锁）**：

| 缺口 | 本维锁定 |
|---|---|
| `deleteSession` 不关 tab（现码 `sessionCrudActions.deleteSession` + `SessionCoordinator` + 侧栏 `getState().deleteSession` 均不碰 shell） | 删除会话必须 `removeTab`；这是验收硬条，不是可选 |
| 全局 `__pending_draft__` 单例 vs「每叶可独立 +」 | 哨兵改为 **per-tab**（`__pending_draft__:${tabId}`）；同叶多次 `+` 允许多个草稿 tab |
| `commitDraftIfNeeded` 只改 `sessionStore`，再 `openOrFocusSession` 会多开一张 tab | 新增 `promoteDraftTab`：就地改该草稿 tab 的 `sessionId`，禁止再 push |
| `sessionStore.activeSessionId` 仍是窗口级单值 | 保留单值；**永远等于活动叶的画面会话**。各叶内容读自己的 `activeTab`，不读全局去覆盖邻居 |
| ADR `session-pending-draft-adr.md` 仍写全局单例 | 运行时契约以本维为准；ADR 正文留给后续文档波修订，本轮不改该文件 |

**非目标**：胶囊/顶栏皮肤；维 04 坞投影；维 05 `PaneHeader` JSX；维 06 拖拽；保留 columns 第二布局。

---

## 1. 最终状态：`workspaceShellStore` 还剩什么

### 1.1 字段（写源）

```ts
interface WorkspaceShellState {
  /** 冷启动门闩：hydrate / migrate 完成前 UI 不画多叶，避免闪帧 */
  shellReady: boolean;
  /**
   * 可选焦点缓存：最近一次成功聚焦的 chat 叶 id。
   * 不是标签写源。仅当 `layoutTreeStore.activeLeafId` 暂时对不上 chat 叶
   * （prune 刚结束、restore 尚未 setActiveLeaf）时，作为「当前活动 chat 叶」回退。
   * 每次 `setActiveLeaf` 命中 chat 叶时更新；prune 掉该叶时清空或改成新活动叶。
   */
  lastChatLeafId: string | null;
}
```

**删除的状态字段**（禁止残留、禁止 persist、禁止 selector 再读）：

- `openTabs: TabSurface[]`
- `activeTabId: string | null`

派生（只读，禁止当写源；实现放维 02 查询或本维薄包装）：

| 需要的值 | 读法 |
|---|---|
| 窗口打开了哪些会话 | 先序扫描全部 `leaf.tabs`（跳过 draft 哨兵） |
| 当前画面会话 | `pictureFromActiveLeaf()` → 活动 chat 叶 `tabs.find(activeTabId)` |
| 某叶条带 | 该叶 `tabs` 原样（草稿 tab 也在数组里，维 05 决定是否画文字胶囊） |
| `getActiveTab()` | `pictureFromActiveLeaf()` 的 tab，找不到则 `null` |

建议默认**留下** `lastChatLeafId`。不加也行（回退 `listChatLeaves()[0]`，I2 保证至少一叶），但侧栏打开未放置会话时「当前活动叶」必须稳定，缓存能避免 `activeLeafId === null` 时误落到第一叶。

### 1.2 `types.ts` 收缩

`workspace-shell/types.ts` 最终只保留：

- `WorkspaceShellState`（上表）
- 本 store 的 action 接口（见 §4）

迁走（维 01 `sessionTabModel.ts` 为权威，本文件可临时 re-export，维 07 删 re-export）：

- `TabSurface` → `SessionTab`（字段：`tabId` / `sessionId` / `title` / `workspaceKey` / `dock`；废弃 `kind`）
- `RightToolDockState` / `createDefaultDock` / `mintTabId`
- `TabKind`

`WorkspaceShellStore` 不再 `extends` 带 `openTabs` 的旧 state。

### 1.3 persist

- Shell **停写**标签列表。`workspaceShellStore` 不接 zustand persist。
- 树 persist（`crish-layout-tree-v1::${windowId}`）在维 01 升级后已含 `leaf.tabs`。
- Legacy map `crish_open_session_tabs_v1`：只作冷启动一次性输入（§7），运行期零写入。

---

## 2. 活动 chat 叶解析（禁止偷叶）

本维所有「打开未放置会话 / 点 +」都先解析目标叶。这是唯一允许的回退，**不是** `bindActiveChatLeafSession`。

```ts
function resolveActiveChatLeaf(): LayoutLeaf {
  const treeStore = useLayoutTreeStore.getState();
  const chats = listChatLeaves(treeStore.tree.root); // 维 02：仅 panelId==='chat'
  if (chats.length === 0) {
    // I2 被破坏（persist 损坏）。禁止在此偷绑。
    // 调维 02 `ensureAtLeastOneChatLeaf()`：单叶 + 一个 draft tab，然后重读。
    throwIfStillEmpty();
  }

  const byActive = chats.find((l) => l.id === treeStore.activeLeafId);
  if (byActive) return byActive;

  const byCache = chats.find((l) => l.id === get().lastChatLeafId);
  if (byCache) return byCache;

  return chats[0]!; // 无焦点：落到先序第一片 chat 叶。不改它已有 tabs。
}
```

**禁止**的旧策略（现码 `leafBindingHelpers.bindActiveChatLeafSession`）：

| 旧规则 | 为何删 |
|---|---|
| 单 chat 叶 → `setLeafSessionId` 覆盖该叶身份 | 1:1 偷绑；该叶其它 tab 被投影层「看起来还在」 |
| 多 chat 且有 unbound → 绑 unbound | 未放置 tab 不进入任何 `tabs`，靠 `tabsForUnit` 投影到活跃条 |
| 多 chat 且无 unbound → 绑当前活动叶 / 不 auto-split | 验收禁止的「tab 可开而无 leaf」；或覆盖活动叶 `sessionId` |
| 已有 bound leaf → 只 `setActiveLeaf` | 这一条语义上接近 I1「已打开则聚焦」，但旧实现不改 `tabs`、靠 1:1 `sessionId`。新实现改为 `activateTab(那一叶, 那一 tab)` |

**未放置**的唯一定义：该 `sessionId`（非 draft）不在任何叶的 `tabs` 里。处置：`openSession` push 进**当前活动 chat 叶**并激活。邻叶 `tabs` 一字不改（I3）。

**已放置**：全树找到那一个 tab（I1），`activateTab` 那一叶。这不是偷叶，是聚焦已有所有权。

---

## 3. 画面会话同步（composer / 侧栏高亮跟活动叶）

```ts
function pictureFromActiveLeaf(): SessionTab | null {
  const leaf = resolveActiveChatLeaf();
  return leaf.tabs.find((t) => t.tabId === leaf.activeTabId) ?? leaf.tabs[0] ?? null;
}

function syncSessionFromActiveLeaf(): void {
  const tab = pictureFromActiveLeaf();
  const session = useSessionStore.getState();
  if (!tab) {
    session.enterDraftMode(/* workspaceKey 回退当前项目 */);
    return;
  }
  rememberChatLeaf(/* 该叶 id */); // 更新 lastChatLeafId
  if (isPendingDraft(tab.sessionId)) {
    // 必须把 activeSessionId 写成【该 tab 的哨兵】，不是全局 '__pending_draft__'
    session.enterDraftMode(tab.workspaceKey, { draftSessionId: tab.sessionId });
  } else {
    if (session.activeSessionId !== tab.sessionId) {
      session.setActiveSessionId(tab.sessionId);
    }
  }
}
```

不变量：

- `sessionStore.activeSessionId` 在每次会话手势结束后 == 活动叶画面 tab 的 `sessionId`（真会话或该 tab 的 draft 哨兵）。
- 非活动叶的 ChatCard **只读本叶** `tabs[activeTabId].sessionId`（维 05 接线）。禁止再写 `inDraft && isActive ? global : leaf.sessionId`（现码 `TreeLeafPanel.tsx:97-103`：全局草稿会把活动叶钉成欢迎面，这正是单例抢画面）。
- Composer 发送作用域 = 活动叶画面会话（总案 §2 派生）。点非活动叶必须先走 `focusLeaf` → `syncSessionFromActiveLeaf`，再输入。

---

## 4. 每个旧 action 的新实现

下列伪代码全部落在 `workspaceShellStore`（门面）。树变换 **零** `set({ openTabs })`、零 `setLeafSessionId`、零 `applyDockToTree`、零 `ensureAdapterShape`、零 `dedupeSessionLeavesInStore`。失败时维 02 原样返回树，本维不补写。

签名以维 02 为准（本维调用，不在此重做几何）：

```ts
// 维 02 提供（layoutTreeStore actions 或纯函数 + setTree）
tree.activateTab(leafId, tabId): void          // 设叶 activeTabId；setActiveLeaf；I3
tree.addTab(leafId, tab?: Partial<SessionTab>): SessionTab
  // 缺省 mint：tabId + draft 哨兵 + default dock + 当前 workspaceKey；push 并激活
tree.openSession(sessionId, opts: {
  title: string;
  workspaceKey: string;
  activeLeafId: string;                        // 未放置时的目标叶，由本维传入
}): { leafId: string; tabId: string; created: boolean }
tree.removeTab(leafId, tabId): void            // 叶内退邻居；空则 prune；根空 → 单 draft 叶（I2）
tree.promoteDraftTab(draftSessionId, realSessionId, patch?: { title?: string }): void
tree.updateTabTitle(sessionId, title): void    // 先序找到唯一真会话 tab
tree.updateTabDock(tabId, patch): void         // 维 04 主用；本维 close 不碰 dock
tree.findTabBySessionId(sessionId): { leafId; tab } | null
tree.findTabByTabId(tabId): { leafId; tab } | null
```

### 4.1 `openOrFocusSession(sessionId, opts?)`（含侧栏）

现码：过滤全局草稿 tab → 已有则激活 + `bindActiveChatLeafSession`；否则 `openTabs.push` + `syncOpenTabsToLegacy` + bind。  
消费方：`compositionRoot.session.openOrFocusSession`、`useSidebarHandlers.handleSelectSession`、`useSidebarContextMenu`、slash send、MCP。

```ts
openOrFocusSession(sessionId, opts?) {
  const sid = sessionId.trim();
  if (!sid || isPendingDraft(sid)) return;      // 草稿不是「打开会话」

  const title = resolveChromeSessionTitle(sessionFromStore(sid), opts?.title);
  const workspaceKey =
    canonicalSessionFolder(opts?.workspaceKey) ||
    sessionFromStore(sid)?.folder ||
    workspaceKeyNow() ||
    GENERAL_FOLDER;

  const targetLeaf = resolveActiveChatLeaf();
  const result = tree.openSession(sid, {
    title,
    workspaceKey,
    activeLeafId: targetLeaf.id,                // 未放置 → 该叶；已放置 → 维 02 忽略此值、聚焦已有叶
  });
  // 维 02 守 I1：已在某叶 tabs → activateTab 那一叶那 tab，不复制、不改邻叶
  //           不在任何叶 → push 到 activeLeafId 的 tabs 末尾并激活

  set({ lastChatLeafId: result.leafId });
  useSessionStore.getState().setActiveSessionId(sid);
  // 禁止：syncOpenTabsToLegacy / bindActiveChatLeafSession / ensureAdapterShape / dedupe
}
```

侧栏 `handleSelectSession` **签名不变**，仍调 `root.session.openOrFocusSession`。行为变化：

- 两叶 A=s1 / B=s2，活动叶 = B，点侧栏 s3（未放置）→ s3 进入 **B.tabs**，A 不动。
- 两叶，s3 已在 B.tabs，活动叶 = A，点侧栏 s3 → 聚焦 B（I1），不把 s3 再塞进 A。
- 禁止再出现「s3 进了 openTabs 但没有 leaf、条带靠 unplaced 投影挂在活跃 unit」。

### 4.2 `activateTab`

现码：只收 `tabId`；切到真会话时**删掉全局草稿 tab**；`bindActiveChatLeafSession`。  
新签名必须带叶（I6 / 维 05 点条带时已知 `leaf.id`）：

```ts
activateTab(leafId: string, tabId: string) {
  const loc = tree.findTabByTabId(tabId);
  if (!loc || loc.leafId !== leafId) return;    // 失败原样；禁止跨叶误激活
  tree.activateTab(leafId, tabId);              // I3：只改该叶 activeTabId + setActiveLeaf
  set({ lastChatLeafId: leafId });
  syncSessionFromActiveLeaf();
  // 禁止：过滤其它叶的 draft tab；禁止因切到真会话而关掉邻叶草稿
}

/** 兼容旧调用（仅内部 / 尚未改的测试）：按 tabId 反查叶 */
activateTabByTabId(tabId: string) {
  const loc = tree.findTabByTabId(tabId);
  if (loc) get().activateTab(loc.leafId, loc.tabId);
}
```

`compositionRoot` 对外只暴露带 `leafId` 的版本。维 05 的 `PaneHeader.handleTabClick` 只调这一条，禁止再叠 `setLeafSessionId` + `bindActiveChatLeafSession` + `setActiveSessionId`（现码 `PaneHeader.tsx:100-114` 三写）。

### 4.3 `closeTab` / `closeTabBySessionId`

现码：`closeSessionTab` 写 legacy map → kill PTY → **`removeSessionUnitFromTree`**（关 tab = 拆 unit）→ 按全局 `openTabs` 找邻居 → 无邻居则 `enterDraftMode` + `ensureChatOnlyTree`。

```ts
closeTab(leafId: string, tabId: string) {
  const loc = tree.findTabByTabId(tabId);
  if (!loc || loc.leafId !== leafId) return;
  const closing = loc.tab;

  if (!isPendingDraft(closing.sessionId)) {
    void import('../../api/ptyRegistry')
      .then((m) => m.killPtyForSessionBackground(closing.sessionId))
      .catch(() => {});
  }

  tree.removeTab(leafId, tabId);
  // 维 02：
  // - 删的是 active → 仅该叶内退（优先左邻）
  // - 叶空 → prune（兄弟提升）；根被删光 → 单叶 + 一个 draft tab（I2）
  // - 不碰邻叶 tabs；不摘「unit / tool 子树」（坞在 tab.dock，维 04）

  const chats = listChatLeaves(tree.tree.root);
  const still = chats.find((l) => l.id === get().lastChatLeafId);
  if (!still) {
    const next = chats.find((l) => l.id === tree.activeLeafId) ?? chats[0] ?? null;
    set({ lastChatLeafId: next?.id ?? null });
  }
  syncSessionFromActiveLeaf();
}

closeTabBySessionId(sessionId: string, _workspaceKey?: string) {
  if (!sessionId || isPendingDraft(sessionId)) return;
  const loc = tree.findTabBySessionId(sessionId);
  if (loc) get().closeTab(loc.leafId, loc.tab.tabId);
  else {
    // 树上没有 tab：仍释放 PTY（侧栏删未打开会话 / 脏 legacy）
    void import('../../api/ptyRegistry')
      .then((m) => m.killPtyForSessionBackground(sessionId))
      .catch(() => {});
  }
}
```

关最后一 tab：维 02 已退化成带 draft tab 的单叶；本维 `syncSessionFromActiveLeaf` 进入该哨兵草稿。**不要** `ensureChatOnlyTree()`（它会拍扁 multi-chat）。**不要** `activeTabId = null` 且草稿不进数组（旧 ADR 视觉：草稿无标签）——总案翻转：草稿是真 tab。条带是否画「新对话」文字由维 05 决定，本维数组里必须有这一项（I2）。

### 4.4 `openNewDraftTab`

现码：从 `openTabs` 滤掉草稿、`activeTabId=null`、`enterDraftMode`、**把活动叶 `sessionId` 解绑**、`ensureAdapterShape`。这是全局单例抢画面的实现。

新签名（维 05 点某叶 `+` 必须传入 `leafId`；快捷键 / 侧栏「新对话」可省略）：

```ts
openNewDraftTab(opts?: { leafId?: string; workspaceKey?: string } | string) {
  // 兼容旧调用 openNewDraftTab(workspaceKey: string)
  const args = typeof opts === 'string' ? { workspaceKey: opts } : (opts ?? {});
  const chats = listChatLeaves(tree.tree.root);
  const leaf =
    (args.leafId && chats.find((l) => l.id === args.leafId)) ||
    resolveActiveChatLeaf();

  const workspaceKey =
    canonicalSessionFolder(args.workspaceKey) ||
    workspaceKeyNow() ||
    GENERAL_FOLDER;

  const tab = tree.addTab(leaf.id, { workspaceKey });
  // 维 02：该叶 push 一个 draft tab（独立哨兵）并激活；邻叶不动（I3）
  // 同叶已有草稿 tab 时仍再 push（每点一次 + 一张空白 tab），不复用邻叶/本叶旧草稿

  set({ lastChatLeafId: leaf.id });
  useSessionStore.getState().enterDraftMode(workspaceKey, {
    draftSessionId: tab.sessionId,
  });
}
```

两叶各点 `+`：各得自己的 draft tab；B 点 `+` 时 A 的 tabs 与画面不变。快捷键 `new_session`（`AppShortcuts.ts:90`）不带 `leafId` → 落在当前活动 chat 叶。

### 4.5 `reorderSessionTab`

现码：按 `workspaceKey` 重排**全局** `openTabs` + `moveSessionTab` 写 legacy map。  
新语义：条内重排 = 维 02 `moveTab` 同叶改下标。全局跨叶顺序不再存在。

```ts
reorderSessionTab(sessionId: string, beforeSessionId: string | null) {
  const src = tree.findTabBySessionId(sessionId);
  if (!src) return;
  const leaf = /* 该叶 */;
  let insertIdx = leaf.tabs.length;
  if (beforeSessionId) {
    const i = leaf.tabs.findIndex((t) => t.sessionId === beforeSessionId);
    if (i >= 0) insertIdx = i;
  }
  tree.moveTab(src.leafId, src.tab.tabId, src.leafId, insertIdx);
  // 不写 legacy map
}
```

跨叶拖拽不走本函数，走维 06 → `moveTab` / `splitTab`。

### 4.6 `updateRightDock`

现码：改 `openTabs[i].rightDock` + `applyDockToTree`（会切 `H(chat, tool)`）。  
本维改为转发维 02 `updateTabDock`（只改 `SessionTab.dock`）。**禁止**再调 `applyDockToTree`（维 04 删除该投影）。`openTool.ts` 仍调 `shell.updateRightDock` 时，03 落地后语义已是「改 tab.dock」，04 再把开工具改成只走 `updateTabDock` + 叶内抽屉。

```ts
updateRightDock(tabId: string, patch: Partial<RightToolDockState> | RightToolDockState) {
  tree.updateTabDock(tabId, patch);
}
```

### 4.7 `syncOpenTabTitles`

```ts
syncOpenTabTitles(overrides?: Readonly<Record<string, string>>) {
  for (const tab of scanAllTabs()) {
    if (isPendingDraft(tab.sessionId)) continue;
    if (overrides && overrides[tab.sessionId] === undefined) continue;
    const resolved = resolveTabSurfaceTitle(tab.sessionId, overrides?.[tab.sessionId]);
    if (resolved === tab.title) continue;
    if (isDefaultSessionTitle(resolved) && tab.title.trim() && !isDefaultSessionTitle(tab.title)) {
      continue; // 旧保护：EMPTY 回落不得盖真实标题
    }
    tree.updateTabTitle(tab.sessionId, resolved);
  }
}
```

### 4.8 `resetToCleanDraft`

冷启动 / restore 失败 / 显式关光。仍保留。

```ts
resetToCleanDraft(workspaceKey?: string) {
  void import('../../api/ptyRegistry').then((m) => m.killAllPtys()).catch(() => {});
  const key = canonicalSessionFolder(workspaceKey) || workspaceKeyNow() || GENERAL_FOLDER;
  tree.resetToSingleDraftLeaf(key);            // 维 02：单 chat 叶 + 一个 draft tab（I2）
  const leaf = listChatLeaves(tree.tree.root)[0]!;
  const tab = leaf.tabs[0]!;
  set({ lastChatLeafId: leaf.id });
  useSessionStore.getState().enterDraftMode(key, { draftSessionId: tab.sessionId });
}
```

不再 `set({ openTabs: [], activeTabId: null })`，不再 `ensureChatOnlyTree` 以外的拍扁（由维 02 一条命令完成）。

### 4.9 `migrateFromOpenTabsMap`

**删除生产路径上的常驻实现。** 冷启动只调维 01 迁移函数一次（§7）。本 store 若暂时留同名方法，仅转发给维 01，维 07 删除。

### 4.10 `setShellReady` / `getActiveTab`

```ts
setShellReady(ready: boolean) { set({ shellReady: ready }); }

getActiveTab(): SessionTab | null { return pictureFromActiveLeaf(); }
```

`App.tsx` 继续订阅 `shellReady` 做门闩，字段保留。

### 4.11 新增：`focusLeaf` / `promoteDraftTab` / `deleteSessionAndCloseTab`

```ts
/** 点叶面：聚焦该叶并把 composer 切到该叶画面会话。维 05 TreeLeafPanel 用。 */
focusLeaf(leafId: string) {
  const chats = listChatLeaves(tree.tree.root);
  const leaf = chats.find((l) => l.id === leafId);
  if (!leaf) return;
  tree.activateTab(leafId, leaf.activeTabId);  // 或 setActiveLeaf + sync
  set({ lastChatLeafId: leafId });
  syncSessionFromActiveLeaf();
}

/** 首条发送：草稿 tab 就地转真会话。见 §5.3 */
promoteDraftTab(draftSessionId: string, realSessionId: string, title?: string) {
  if (!isPendingDraft(draftSessionId) || !realSessionId || isPendingDraft(realSessionId)) return;
  if (tree.findTabBySessionId(realSessionId)) {
    // I1：真会话已在某叶。只激活已有 tab，丢掉这次 mint 的重复身份由调用方处理。
    const loc = tree.findTabBySessionId(realSessionId)!;
    get().activateTab(loc.leafId, loc.tab.tabId);
    return;
  }
  tree.promoteDraftTab(draftSessionId, realSessionId, { title });
  syncSessionFromActiveLeaf();
}

/** 侧栏删除会话。现码不关 tab，必须修。 */
deleteSessionAndCloseTab(sessionId: string): boolean {
  const sid = sessionId.trim();
  if (!sid || isPendingDraft(sid)) return false;
  get().closeTabBySessionId(sid);              // 树上有 tab 就 removeTab + 杀 PTY
  const removed = useSessionStore.getState().deleteSession(sid);
  // deleteSession 数据面：见 §5.4，禁止再用 sessions[] 邻居覆盖画面会话
  syncSessionFromActiveLeaf();                 // 以树为准校正 activeSessionId
  return removed;
}
```

---

## 5. PENDING_DRAFT：全局单例 → per-tab 哨兵

### 5.1 身份规则

现码：`PENDING_DRAFT_SESSION_ID = '__pending_draft__'`（`packages/shared-types/src/session-identity.ts`），`isPendingDraft` 精确相等。`enterDraftMode` 一律把 `activeSessionId` 写成这个单例。两叶无法同时各有空白欢迎面。

新规则：

```ts
// shared-types（邻接面，本维落地时必须改，否则 I1 无法区分两叶草稿）
export const PENDING_DRAFT_SESSION_ID = '__pending_draft__' as const;
export const PENDING_DRAFT_PREFIX = '__pending_draft__:' as const;

export function mintDraftSessionId(tabId: string): string {
  return `${PENDING_DRAFT_PREFIX}${tabId}`;
}

export function isPendingDraftSessionId(id: string | null | undefined): boolean {
  if (!id) return false;
  return id === PENDING_DRAFT_SESSION_ID || id.startsWith(PENDING_DRAFT_PREFIX);
}
```

- **I1 只约束非 draft 哨兵**（总案原文）。各叶 / 同叶多个 draft tab 的哨兵必须互不相同。
- 用 `tabId` 而不是 `leafId` 做后缀：同叶两次 `+` 会有两张草稿 tab。
- 光杆 `__pending_draft__` 仅作脏数据 / 测试 / `clearDraft` 无叶时的回退；**生产路径 mint 出来的草稿 tab 禁止再用光杆单例**。
- `sessions[]` / 侧栏仍然不出现任何 draft 哨兵（ADR 这条保留）。
- `desktop/src/store/draftSession.ts` 继续 re-export；`isPendingDraft` 改走前缀判断。

### 5.2 `enterDraftMode` 扩展

文件：`sessionDraftActions.ts`（邻接面，本维串行改，否则门面无法写入 per-tab 哨兵）。

```ts
enterDraftMode(folder?: string, opts?: { draftSessionId?: string }) {
  set((state) => {
    const id =
      (opts?.draftSessionId && isPendingDraft(opts.draftSessionId)
        ? opts.draftSessionId
        : PENDING_DRAFT_SESSION_ID);
    state.activeSessionId = id;                 // 不再写死光杆单例
    state.draftFolder = folder?.trim() || getActiveProjectId() || GENERAL_FOLDER || '';
    state.activeAgentId = null;
    state.panelAgentId = null;
    syncActiveTerminalSession(id);
  });
}
```

`activeSessionId` 保持 `string`、禁止 `null`（ADR 硬接口 3 条里这条保留）。

### 5.3 提交：`commitDraftIfNeeded` + `promoteDraftTab`

现码 `slashSendDraftManager.commitDraftAndOpenShell`：`commitDraftIfNeeded` mint 后若 `openTabs` 没有该 id，再 `openOrFocusSession` —— 在「草稿已是真 tab」模型下会**多一张 tab**。

新发送路径：

```ts
function commitDraftAndPromote(): string {
  const st = useSessionStore.getState();
  const draftId = st.activeSessionId;
  const newId = st.commitDraftIfNeeded();       // 仍只负责 sessions[] mint + 把 active 换成真 id
  if (!newId || isPendingDraft(newId)) return newId;
  if (isPendingDraft(draftId)) {
    getCompositionRoot().shell.promoteDraftTab(draftId, newId);
  }
  return newId;
}
```

- 只升级**当前 `activeSessionId` 对应的那一张**草稿 tab。
- 邻叶草稿 tab 原样保留。
- 禁止 `openOrFocusSession(newId)` 作为 commit 的补建手段。
- `commitDraftIfNeeded` 若发现 active 已是真会话，原样返回（旧契约），不调 promote。

`session.enterDraft`（无 tab）仍给测试 / 脏态用；**用户「新对话」只走 `shell.openNewDraftTab`**。

### 5.4 `deleteSession` 必须摘 tab

现码证据：

- `sessionCrudActions.ts:341-377`：从 index 删会话，若是 active 则 `pickFallbackActiveSessionId`（**sessions[] 邻居**，不是 open tabs）。
- `SessionCoordinator.deleteSessionCascade`：streaming / snapshots / terminalStore，**不调 closeTab**。
- 侧栏 `useSidebarContextMenu.ts:239-240`：`root.session.getState().deleteSession(...)` 直打数据面。

新契约：

1. 生产删除入口改为 `compositionRoot.session.deleteSession` → `shell.deleteSessionAndCloseTab`（§4.11）。
2. `sessionStore.deleteSession` 改为**纯数据面**：删 index / runtime / streaming。若 `wasActive`，**不要**用 `pickFallbackActiveSessionId` 覆盖 `activeSessionId`（那会和树画面分叉）。可临时留着，但门面在其后立刻 `syncSessionFromActiveLeaf()` 覆盖。
3. 树上有该 session 的 tab → `removeTab`（关最后一 tab 走 I2 单 draft 叶）。
4. 树上没有 tab（未打开的历史会话）→ 只删数据；若它碰巧等于 `activeSessionId`（脏），仍 `syncSessionFromActiveLeaf()`。

禁止「删会话后 tab 还在条上、点进去是空壳」。

---

## 6. 删除清单

本维落地即删符号，禁止改成 no-op 长期留着。维 05 未改的调用方在实施波必须同批改编译（§9.4）。

### 6.1 `leafBindingHelpers.ts` — 整文件拆空或删除

| 符号 | 处置 |
|---|---|
| `bindActiveChatLeafSession` | **删除**。语义由 `openOrFocusSession` / `activateTab` / `focusLeaf` 取代 |
| `removeSessionUnitFromTree` | **删除**。关 tab 走 `tree.removeTab`，不走 `removeUnitBySessionId` |
| `neighborDockNeedsProject` | **删除**。关 tab 不再 `applyDockToTree`；坞在 `tab.dock`（维 04） |
| `dedupeSessionLeavesInStore` | **移出本维调用**。总案：仅 persist 损坏兜底，禁止日常纠偏。若维 01/02 还要，放迁移函数内，不挂在每个 action 末尾 |

文件本身：无剩余职责则 **删除文件**，`index.ts` 停止 re-export。禁止留空壳「以后再用」。

### 6.2 `unitTabPlacement.ts` + `unitTabPlacement.test.ts`

**整模块删除**（总案 §7）。投影层 `tabsForUnit` / `listChatUnits` / `unitHostingUnplaced` / `resolveStripWorkspaceKey` 全部是 `openTabs` + `leaf.sessionId` 的产物。

维 05 `PaneHeader.tsx:22, 58-64` 的 import 改为读 `leaf.tabs`。本维不改 `PaneHeader` 源码，但删除模块后 05 必须同批改 import，否则编译红。

### 6.3 `workspaceShellStore.ts` 内删除的行为

- 一切 `set({ openTabs, activeTabId })`
- `syncOpenTabsToLegacy` / `closeSessionTab` / `moveSessionTab` 运行期调用
- `applyDockToTree` / `ensureAdapterShape` / `ensureChatOnlyTree`（`resetToCleanDraft` 改为维 02 `resetToSingleDraftLeaf`）
- `listChatLeaves` + `setLeafSessionId(undefined)` 解绑（`openNewDraftTab` 旧实现）
- 切到真会话时 `filter(!isPendingDraft)` 清全局草稿
- `MAX_OPEN_SESSION_TABS` 切片（16）。上限若还要，由维 01/02 在 `addTab`/`openSession` 失败原样返回；本维不发明数字、不在门面 `slice(-16)`

### 6.4 `compositionRoot.tree.setLeafSessionId`

从 `TreeFacade` **删除**。生产 UI / shell 不得再有这条后门。测试 `compositionRoot.test.ts` / `ownershipEnforce.test.ts` 的「tree 有 setLeafSessionId」断言一并改掉。

侧栏「拆分视图」`useSidebarContextMenu.openSessionInChatSplit`（`setLeafSessionId` + `splitLeaf`）改走维 02 `splitTab`；接线属维 05，03 拆掉 API 后它必须改，否则编译红。

### 6.5 `shellReadBridge` / `shellRegistry`

现桥暴露 `getOpenTabs` / `setOpenTabs` / `resetToCleanDraft`，给 `adapterShape` / `layoutRestorePolicy.syncShellDocksFromTree` 用。

- `getOpenTabs` / `setOpenTabs`：**删除**。坞状态读 `tab.dock`（树），不再反向写入 shell 数组。
- `resetToCleanDraft`：可留（`applySafeCleanColdStart`），或改为直接调 store action。
- `syncShellDocksFromTree`：维 04/01 迁移一次后删除（运行期无 shell tabs 可 sync）。

### 6.6 注释与所有权文档

`workspaceShellStore.ts` 文件头、`index.ts` 头、`compositionRoot.ts` 头、`layout-tree/index.ts`「Tab bar order / openTabs → workspaceShellStore」——全部改成「shell = 命令门面 + shellReady；标签在叶上」。禁止再写「Session identity lives on TabSurface」。

---

## 7. Legacy open-tabs map

文件：`apps/crish-desktop/src/api/workspaceChromeTabs.ts`。  
现运行期双写：`syncOpenTabsToLegacy`（打开）/ `closeSessionTab`（关闭）/ `moveSessionTab`（重排）。Hydrate：`hydrateWorkspaceShell.ts` 读 map → `shell.migrateFromOpenTabsMap`。

### 7.1 运行期

**停写。** `openOrFocusSession` / `closeTab` / `reorderSessionTab` 删除对 `syncOpenTabsToLegacy` / `closeSessionTab` / `moveSessionTab` 的调用。`openSessionTab` 不再被生产路径引用。

`MAX_OPEN_SESSION_TABS`、`buildSessionTabsForWorkspace` 等展示辅助若无消费方可在维 07 删。本维不改 chrome 视觉。

### 7.2 一次性迁移输入

冷启动（`hydrateWorkspaceShell`，邻接面，本维改调用）：

```
1. 读树（可能仍是旧 leaf.sessionId + tool 叶，由维 01 迁移函数消化）
2. 读 legacy map（loadLegacyOpenTabsMap）——仅此次
3. 调维 01：
     migrateToLeafOwnedTabs({ tree, openTabsMap, knownSessions })
   规则（总案 §6，此处不重做算法）：
     - 每个有 sessionId 的 chat 叶 → tabs = [对应 SessionTab]
     - map 里未出现在任何叶上的 id → 并入当时活动 chat 叶（或第一片）末尾，不新建叶
     - 非法（空 tabs、重复 sessionId）在迁移函数内归一
4. setTree(新树)；shell 只 setShellReady(true)，不写 openTabs
5. 可选：saveOpenTabsMap({}) 或 delete key，避免下次又当输入。推荐清空。
```

`restoreLastWorkspace === false`：`applySafeCleanColdStart` → `resetToCleanDraft`（单 draft 叶），**不读 map**。

此后任何代码路径 `loadLegacyOpenTabsMap` 只允许出现在迁移函数 / 其测试。运行期 selector `selectActiveTabSessionId(s.openTabs)` 删除，改 `pictureFromActiveLeaf()`。

---

## 8. `compositionRoot` 新契约

### 8.1 `ShellFacade`

```ts
export type ShellFacade = {
  getState: () => ReturnType<typeof useWorkspaceShellStore.getState>;
  setShellReady: (ready: boolean) => void;
  openNewDraftTab: (opts?: { leafId?: string; workspaceKey?: string } | string) => void;
  activateTab: (leafId: string, tabId: string) => void;
  closeTab: (leafId: string, tabId: string) => void;
  focusLeaf: (leafId: string) => void;
  promoteDraftTab: (
    draftSessionId: string,
    realSessionId: string,
    title?: string
  ) => void;
};
```

`getState()` 仍返回 store（含 `openOrFocusSession` / `closeTabBySessionId` / `resetToCleanDraft` / `syncOpenTabTitles` / `updateRightDock` / `getActiveTab`），供尚未改完的内部调用。UI 新代码走门面上的具名方法。

旧 `openNewDraftTab(workspaceKey?: string)` 用联合类型兼容一波；维 07 删 string 重载。

### 8.2 `SessionFacade`

```ts
export type SessionFacade = {
  getState: typeof getSessionStoreState;
  getActiveSessionId: typeof getActiveSessionId; // == 活动叶画面；手势后由 shell sync
  enterDraft: (folder?: string) => void;         // 测试/脏态；用户入口是 shell.openNewDraftTab
  openOrFocusSession: (
    sessionId: string,
    opts?: { title?: string; workspaceKey?: string }
  ) => void;                                     // 实现改了，签名不变
  deleteSession: (sessionId: string) => boolean; // 新增：关 tab + 数据面
  pinSession / unpinSession / archiveSession / unarchiveSession / branchSession; // 不变
};
```

```ts
openOrFocusSession: (sessionId, opts) =>
  useWorkspaceShellStore.getState().openOrFocusSession(sessionId, opts),

deleteSession: (sessionId) =>
  useWorkspaceShellStore.getState().deleteSessionAndCloseTab(sessionId),
```

侧栏删除从 `root.session.getState().deleteSession` 改为 `root.session.deleteSession`（维 05 接线；03 先把门面补上）。

### 8.3 `TreeFacade`

```ts
export type TreeFacade = {
  getState: () => ReturnType<typeof useLayoutTreeStore.getState>;
  // 删除 setLeafSessionId
};
```

UI 不经 tree 门面开/关/激活会话。Hydrate 只 `getState()` 读树 + 维 01 迁移后 `setTree`。

### 8.4 所有权注释（必须改）

`compositionRoot.ts` 头表格：

| Facade | 现在 | 本维之后 |
|---|---|---|
| `shell` | TabSurface / dock 写源 | 会话手势门面 + `shellReady`（+ 可选 `lastChatLeafId`） |
| `session.openOrFocusSession` | 委托 shell（改 openTabs + bind） | 委托 shell（找叶 + 维 02 `openSession` + sync active） |
| `tree` | `setLeafSessionId` | 只 `getState`；无 leaf↔session 1:1 绑定 API |

禁止：「Components: do not call setActiveSessionId and shell activate for the same open」——新口径是 **shell 手势内部会调 setActiveSessionId**，UI 只调 shell/session 门面一次。UI 再叠 `setActiveSessionId` / `setLeafSessionId` / `bindActiveChatLeafSession` 即违规（维 05 清掉 `PaneHeader` 现有三写）。

---

## 9. 与维 01 / 02 / 05 的接口

### 9.1 维 01 必须提供（本维只消费）

| 符号 | 用途 |
|---|---|
| `SessionTab` / `mintTabId` / `createDefaultDock` | 门面不再 mint 领域类型时，仍可能在测试里用 |
| `isPendingDraftSessionId` 前缀版 + `mintDraftSessionId(tabId)` | §5；也可放 shared-types，01 再导出 |
| `migrateToLeafOwnedTabs({ tree, openTabsMap, knownSessions })` | hydrate 唯一迁移入口 |
| `LayoutLeaf.tabs: SessionTab[]`、`activeTabId: string`、删除 `sessionId` | 本维查询画面会话 |
| I1–I6 类型层 | 本维不在门面重复校验，只不写出违反它们的调用 |

维 01 **不要**再把 `openTabs` 写成运行期字段。

### 9.2 维 02 必须提供（本维只调用）

见 §4 顶部列表。额外：

| 符号 | 失败语义 |
|---|---|
| `openSession` 未放置 | push 到传入的 `activeLeafId`；该 id 不是 chat 叶 → 原样返回，不偷邻叶 |
| `addTab` | 目标叶必须已存在；不因「该叶已有草稿」而拒绝第二次 + |
| `removeTab` 删空 | prune；根空 → 单 draft 叶。返回后本维 sync 画面 |
| `promoteDraftTab` | 找不到 draft 哨兵 → 原样；`realSessionId` 已在树 → 不复制，由本维改 activate |
| `resetToSingleDraftLeaf` | 替换整棵树为单 chat 叶 + 一个 draft tab |
| `ensureAtLeastOneChatLeaf` | 仅 persist 损坏；日常路径不应走到 |

维 02 **不要**调 `setActiveSessionId` / `enterDraftMode` / PTY（副作用留本维）。  
维 02 **不要**实现 `bindActiveChatLeafSession` 的 5 条旧规则。

### 9.3 维 05 必须改的调用（本维不改这些文件）

| 现码 | 改为 |
|---|---|
| `PaneHeader`：`tabsForUnit(openTabs, …)` | `leaf.tabs` |
| `PaneHeader.handleTabClick`：`setActiveLeaf` + `activateTab(tabId)` + `setActiveSessionId` + `setLeafSessionId` + `bindActiveChatLeafSession` | 只 `shell.activateTab(leaf.id, tab.tabId)` |
| `PaneHeader.handleNewTab`：`setActiveLeaf` + `openNewDraftTab('')` | 只 `shell.openNewDraftTab({ leafId: leaf.id })` |
| `PaneHeader.handleTabClose`：`closeTab(tabId)` | `shell.closeTab(leaf.id, tab.tabId)` |
| `TreeLeafPanel`：`inDraft && isActive ? global : leaf.sessionId` | 本叶 `tabs[activeTabId].sessionId`；点叶面 `shell.focusLeaf(leaf.id)` |
| `TreeLeafPanel`：`openTabs.find` + `activateTab` / `openOrFocusSession(leaf.sessionId)` | 删除；`focusLeaf` 已 sync |
| 侧栏删除：`session.getState().deleteSession` | `session.deleteSession` |
| 侧栏拆分：`setLeafSessionId` + `splitLeaf` | 维 02 `splitTab`（或先 `openOrFocusSession` + 用户拖边缘；禁止 1:1 偷绑） |

### 9.4 实施耦合（上报主控，不改总案切分）

维 01 删除 `leaf.sessionId`、把 `tabs` 从 `string[]` 改成 `SessionTab[]` 之后，未改的 `PaneHeader` / `TreeLeafPanel` / `flatten` **会编译失败**。逻辑切分仍是 01→02→03→05，但落地时 01 类型变更必须与 02 命令、03 门面、05 最低限度编译修复同一实现波（或紧随的下一提交，且中间不要求 CI 绿）。本维不把 `PaneHeader.tsx` 拉进文件域。

---

## 10. 验收（效果，附现码对照）

| # | 操作 | 必须看到 | 禁止再出现 |
|---|---|---|---|
| 1 | 两叶，在 **B** 点 `+` | B.tabs 多一个 draft tab，B 显示空白欢迎面；A.tabs 与 A 画面不变；`sessionStore.activeSessionId` = B 那张草稿哨兵（带 B 的 tabId） | 全局 `activeTabId=null`；把 A 或 B 的 `sessionId` 解绑；A 被欢迎面抢走 |
| 2 | 两叶 A=s1 / B=s2，活动叶 B，侧栏打开 **未放置** s3 | s3 进入 **B.tabs** 并激活；A 内容与 tabs 不变；`listChatLeaves` 仍为 2 | `bindActiveChatLeafSession` 把某叶 1:1 改成 s3；s3 进了「全局 openTabs」却不在任何 `leaf.tabs`；unplaced 投影到条带 |
| 3 | 同上，s3 **已在** B.tabs，活动叶是 A，侧栏再点 s3 | 只激活 B 的那张 tab + `setActiveLeaf(B)`；A 不动；不新增 tab | 把 s3 再 push 进 A |
| 4 | 单叶仅 1 个真 tab，关掉它 | 叶还在（或 I2 退化成单 draft 叶）；出现一张草稿 tab；不是空 `openTabs` + 无标签欢迎 | `removeSessionUnitFromTree` 拆掉整棵 multi；`ensureChatOnlyTree` 拍扁邻居 |
| 5 | 侧栏 **删除** 一个已打开为 tab 的会话 | 该 tab 从所在叶消失（空则 prune）；PTY 杀掉；画面切到该叶邻居或 I2 草稿；`sessions[]` 无该 id | 现码：`deleteSession` 后条上仍有胶囊、点进去空壳（`useSidebarContextMenu.ts:239`） |
| 6 | 侧栏删除 **未打开** 的会话 | 只去列表；活动叶 tabs 不变 | 误 `resetToCleanDraft` |
| 7 | 两叶各有草稿，在 B 发送首条 | 只 B 的草稿 tab `sessionId` 变成真 id；A 的草稿 tab 仍在 | `openOrFocusSession` 再开一张；两叶草稿变成同一个 `__pending_draft__` |
| 8 | grep | 生产路径零次 `bindActiveChatLeafSession` / `removeSessionUnitFromTree` / `tabsForUnit` / `syncOpenTabsToLegacy` / `tree.setLeafSessionId` | 为保旧测试把偷绑加回来 |

总案 §9 里「两叶，侧栏打开 s3 进活动叶」与本表 #2 同一条。本维额外把 #5 标红，因为现码明确没做。

---

## 11. 测试改写要点（供维 07，本维实现时不要保绿旧语义）

`workspaceShellStore.test.ts` 现有块必须改或删：

| 现测试意图 | 新断言 |
|---|---|
| `activateTab / bindActiveChatLeafSession` | 已在某叶 → 只改该叶 `activeTabId`；邻叶 tabs 引用不变 |
| `closeTab — remove unit` | 关 tab **不**调用 `removeUnitBySessionId`；叶上剩余 tabs 仍在；dock 在剩下的 tab 上 |
| `openNewDraftTab`「draft 不进 openTabs」 | **反转**：draft 进目标叶 `tabs`；邻叶不变 |
| `closeTab 关光最后 tab：openTabs 为空` | 单叶 + 1 draft tab；`isPendingDraft(picture.sessionId)` |
| `openOrFocusSession` 仅 focus 不 reproject dock | 保持「不投影树几何」；改为不改邻叶 `tabs` |

`focusDockIsolation.test.ts`「不 auto-split」：改写为「未放置加入活动叶 tabs，绝不 split、绝不改邻叶」。  
`unitTabPlacement.test.ts`：随模块删除。  
`hydrateWorkspaceShell.test.ts`：断言不再出现 `openTabs.length`；断言树叶 `tabs`。  
`compositionRoot.test.ts` / `ownershipEnforce.test.ts`：去掉 `setLeafSessionId`；加上 `session.deleteSession`、`shell.activateTab(leafId, tabId)`。

实现波 03 提交前至少跑：`workspaceShellStore` 单测（按新语义重写后）+ `compositionRoot` 单测。全量矩阵归维 07。

---

## 12. 邻接面文件（本维闭合契约所必需，超出「四件套」时串行改）

主文件域仍是任务书四件套。下列若不改，门面无法工作——实施时由同一 Agent 在 03 波串行改，或主控紧随派单，**禁止**留给「以后兼容层」：

| 文件 | 改什么 |
|---|---|
| `packages/shared-types/src/session-identity.ts` | 前缀哨兵 + `mintDraftSessionId` |
| `store/draftSession.ts` | re-export 新 `isPendingDraft` |
| `store/sessionDraftActions.ts` | `enterDraftMode(..., { draftSessionId })` |
| `store/sessionCrudActions.ts` | `deleteSession` 不再用 sessions[] 邻居抢画面 |
| `store/SessionCoordinator.ts` | 级联删除走门面 `deleteSessionAndCloseTab`，或只保留数据面 |
| `app/hydrateWorkspaceShell.ts` | 调维 01 迁移；不再 `migrateFromOpenTabsMap` 写 shell 数组 |
| `hooks/chat-stream/slashSendDraftManager.ts` | `commitDraftAndPromote`，禁止 commit 后再 `openOrFocusSession` |
| `store/workspace-shell/shellSelectors.ts` | 删 `selectActiveTabSessionId(openTabs)` |
| `store/workspace-shell/shellRegistry.ts` / `shellReadBridge.ts` | 删 `getOpenTabs` / `setOpenTabs` |
| `store/workspace-shell/index.ts` | 停止 export `unitTabPlacement` / `leafBindingHelpers` |

不改：`PaneHeader.tsx` / `TreeLeafPanel.tsx`（维 05）、`layoutTreeInsert/*.ts`（维 02）、`adapterShape*.ts` / `openTool.ts`（维 04）、`sessionTabDropCommit.ts`（维 06）。

---

## 13. 诚实边界

- Demo `TreeStore` 的 `cloneNode` 双开会话与本产品 I1 冲突，不抄。
- 旧测试「关 tab 摘 unit」「draft 不进 openTabs」「不 auto-split 但 tab 可无 leaf」与总案相反；维 07 删，本维实现不得为保绿复辟。
- `lastChatLeafId` 是本维对总案「可选焦点缓存」的具体化；不加则 `resolveActiveChatLeaf` 回退第一叶，效果仍满足「未放置进活动叶」，只是 `activeLeafId==null` 时活动叶定义稍弱。
- ADR 文件本轮不改；若计划审计要求文档同源，另开文档波，不阻塞本维实现。
- `MAX_OPEN_SESSION_TABS = 16` 去掉后理论上可开更多 tab；这不是效果降级。若产品要上限，在维 02 命令失败原样返回，不要在 shell 静默 `slice`。
