# Conversation Unit Shell — Multi-Chat + Per-Session Right Dock

| Field | Value |
|-------|-------|
| Date | 2026-07-27 |
| Scope | `apps/crish-desktop` (+ Tauri PTY for terminal) |
| Status | R1–R3 **done**；R4 **in progress** — multi-unit + fixed win buttons |
| Tab bar ADR | **2026-07-29** — 主 UI 为 **全局** session tab row，**不再**以 per-leaf multi-strip 为主：[`progress/shell-global-tab-bar.md`](./progress/shell-global-tab-bar.md) |
| Baseline | Shell Phase 1 Adapter (`analysis/shell_workspace_redesign.md`) |
| Constraint | Max 8 agents per round |
| Phase 2 note | See `analysis/shell_workspace_redesign.md` § Phase 2 |

---

## 1. Problem diagnosis (from screenshots + code)

User-visible failures map to concrete model bugs:

| # | Symptom | Root cause in code |
|---|---------|-------------------|
| U1 | Right panels feel global / not “owned” by each conversation window | `applyDockToTree` projects **active** tab dock onto **one** global tool leaf (`adapterShape.ts`). Multi-chat path strips tools or hangs a single shared tool on the whole chat subtree. |
| U2 | Right-dock toggle sits next to OS window buttons | `AppTopBar` trail hosts `toggleActiveTabRightDock`. Not part of conversation unit chrome. |
| U3 | Dragging top session tabs keeps appending chat panes | `commitSessionSplit` always `splitLeaf` + bind session; **no check** for existing leaf with same `sessionId`; re-drag clones panes. |
| U4 | Top tabs not bound 1:1 to panes | `openTabs` and chat leaves diverge; activate/focus does not reliably `setActiveLeaf` to the leaf that owns that session; close tab does not always remove that leaf. |
| U5 | Right tool tabs cannot drag-split | `RightToolDockHeader` is click/close only; drag path lived in `TopBarToolZone` / tree tab handles and never fully landed on per-dock tabs. |
| U6 | Panes squeeze / look stacked | Absolute % rects without strong min-size; multi-split + shared tool column produces sub-usable widths; no unit-level packing. |
| U7 | Terminal is half product | `TerminalCard` = one-shot shell + line buffer; xterm adapter is **display-only** (`disableStdin: true`). Not interactive PowerShell / ConPTY. |
| U8 | Toolbar under “对话” needs redesign | `ChatHeader` is a floating icon strip; dock toggle and unit identity do not live there. |

Phase 1 design intentionally forbade multi-chat and used a single global tool leaf. Multi-chat was partially bolted on (`LayoutLeaf.sessionId`, `commitSessionSplit`) **without** upgrading the dock projection model — that is the core architectural debt.

---

## 2. Product model (target)

### 2.1 Absolute top bar (global only)

```
[ left sidebar toggle ]  [ session tabs ... + ]  [ help · min · max · close ]
```

- **No** right-dock toggle here.
- Session tabs are the source of truth for open conversation surfaces.
- Dragging a tab onto canvas = place/move that conversation unit (never clone).
- **2026-07-29 决策（supersedes R4「每 unit 一条 strip」主 UI）**：会话标签为 **全局一行**（global session tab row），等宽 tab；**非** per-leaf Obsidian multi-strip 作为主路径。多窗隔离 `openTabs`；新对话仅 `openNewDraftTab`。全文：[`progress/shell-global-tab-bar.md`](./progress/shell-global-tab-bar.md)。

### 2.2 Conversation Unit (per open session in layout)

Each open conversation that appears in the canvas is a **ConversationUnit**:

```
┌─ Unit chrome ──────────────────────────────────────────────┐
│ 项目名/对话 · search · overview · files · diff · terminal · …  [dock] │
├──────────────────────────────┬─────────────────────────────┤
│ Chat body (bound sessionId)  │ Right tool dock (optional)  │
│ messages + composer          │ tool tabs · active body     │
│                              │ (tools may split inside)    │
└──────────────────────────────┴─────────────────────────────┘
```

- Unit chrome：**项目名**或「对话」+ 快捷入口 + **最右**右坞 toggle；**不**再承担该列 openTabs 主标签条（见 global tab bar 决策）。

Invariants:

1. **1 session ↔ 0..1 unit in layout** (open tab may exist without multi-pane; multi-pane never duplicates same session).
2. **Right dock state is per `TabSurface.rightDock`** (already in shell store).
3. Dock UI only renders **inside that session’s unit**, never as a workspace-global column when multi-chat is open.
4. Multiple units ⇒ multiple independent docks can be visible simultaneously.
5. Units tile without overlap; min width/height enforced; sash resize updates unit ratios only.
6. Closing a session tab removes its unit (chat leaf + its tool subtree) and reflows neighbors.

### 2.3 Layout tree mapping (Phase 2 Adapter)

Keep `BinaryTreeWorkspace` host. Encode units as:

```
root = binary tree of UnitRoots
UnitRoot =
  | chatLeaf(sessionId)                         // dock collapsed
  | H-branch( chatLeaf(sessionId), toolSubtree ) // dock open
toolSubtree =
  | toolLeaf(tabs=openPanelIds, activeTab, ownerSessionId)
  | branch of tool leaves (internal tool splits)
```

Critical change vs Phase 1:

- **Stop** rewriting the entire tree from only the active tab’s dock.
- **Apply** dock changes only to the unit owned by that `sessionId`.
- Other units untouched.

---

## 3. Implementation plan (rounds)

### Round 1 — Binding & dock projection (correctness)

| Agent | ID | Mission | Primary files |
|-------|-----|---------|---------------|
| A1 | `session-leaf-invariant` | Pure helpers: find chat leaf by sessionId; assert ≤1 leaf per session; dedupe orphans; unit root discovery | `store/layout-tree/operations.ts` (+ tests), new `conversationUnit.ts` if needed |
| A2 | `session-drag-idempotent` | Fix top-bar session drag: existing leaf ⇒ move/focus; never clone; reject same-session re-split | `useTopBarDrag.ts`, ops for move leaf |
| A3 | `dock-per-unit-project` | Rewrite `applyDockToTree` / ensure* to attach/detach tool **only** under that session’s unit; multi-chat keeps other units | `adapterShape.ts`, tests |
| A4 | `tab-lifecycle-bind` | activateTab focuses unit leaf; closeTab removes unit; openOrFocus binds without wiping multi layout | `workspaceShellStore.ts`, `useChatPanelSync.ts` |
| A5 | `unit-chrome-dock-toggle` | Move right-dock toggle out of AppTopBar trail into per-unit chrome (ChatHeader / unit bar); AppTopBar trail only window chrome + help | `AppTopBar.tsx`, `ChatHeader.tsx`, CSS |
| A6 | `min-size-no-overlap` | Enforce min split ratio / min px while resizing; fix leaf absolute layout so multi-unit never overlaps | `useTreeResize.ts`, flatten/CSS, BinaryTreeWorkspace |
| A7 | `unit-tests-binding` | Tests for 1:1 session-leaf, dock per unit, close removes unit, drag no-clone | new/extend tests under `store/workspace-shell`, `layout-tree` |
| A8 | `docs-sync` | Update shell redesign note Phase 2 section + this plan progress | `analysis/shell_workspace_redesign.md` (append), this file |

### Round 2 — Unit chrome redesign + tool drag-split

| Agent | ID | Mission |
|-------|-----|---------|
| B1 | `unit-chrome-redesign` | Redesign toolbar under “对话”: clear left title, tool openers, dock toggle; remove duplicate global chrome |
| B2 | `tool-tab-drag` | RightToolDockHeader tabs: drag reorder within dock; drag to edges ⇒ split tool pane **within same unit only** |
| B3 | `tool-open-scoped` | `openToolInActiveTab` / ChatHeader openers open tools on **that unit’s session dock**, not only “active” if click came from another unit |
| B4 | `tool-leaf-session-owner` | Tool leaves carry `ownerSessionId` (or parent unit key); tree events route correctly |
| B5 | `drop-zone-unit-scope` | Drop detection: session drops only create/move units; tool drops only within unit domain |
| B6 | `css-unit-polish` | Non-jank chrome, sash hit targets, empty dock states |
| B7 | `integration-tests-ui` | Component/store tests for multi-unit two docks visible |
| B8 | `verify-typecheck` | Desktop typecheck + targeted vitest |

### Round 3 — Real PowerShell terminal (interactive PTY)

| Agent | ID | Mission |
|-------|-----|---------|
| C1 | `rust-pty-session` | Tauri commands: create/destroy/resize/write PTY (portable-pty / ConPTY), events for output |
| C2 | `frontend-pty-bridge` | API layer: open session-scoped PTY, stream bytes, cwd = workspace |
| C3 | `terminal-card-xterm-stdin` | Replace line-buffer UX with interactive xterm (stdin on); session isolation |
| C4 | `assistant-shell-mirror` | Keep optional mirror of agent shell tool output into the same PTY session or side channel (product decision: mirror as annotations, not hijack PTY) |
| C5 | `terminal-lifecycle` | Open dock terminal starts PTY; close tab kills PTY; multi-unit multi-PTY |
| C6 | `pty-tests` | Rust unit + frontend contract tests |
| C7 | `terminal-docs` | Short operator doc |
| C8 | `e2e-smoke` | Manual checklist + automated smoke if available |

### Round 4 — Hardening & residual polish

- Persistence of multi-unit layout + per-tab docks
- Performance under multi-unit stream
- Accessibility / keyboard focus between units
- Final QA against `PERF_VERIFY_CHECKLIST` interaction paths

---

## 4. Non-goals (this plan)

- Multi-window OS instances
- Replacing BinaryTreeWorkspace with a new layout engine
- Full VS Code grid editor groups for arbitrary content
- Changing daemon chat protocol

---

## 5. Acceptance criteria

1. Open two sessions side-by-side; each can show its own terminal/files dock independently.
2. Dragging the same top session tab repeatedly never creates extra panes for that session.
3. Top session tab click focuses the matching unit; close removes that unit only.
4. Right-dock toggle lives on unit chrome, not next to OS window buttons.
5. Tool tabs on the right can be drag-split inside the unit.
6. Units never overlap; min width ~240px chat / ~200px tool (tunable).
7. Terminal: interactive PowerShell prompt (type, see live output, Ctrl+C), not one-shot command form only.
8. Typecheck green; binding/dock unit tests green.
9. **R4（历史字面；主 UI 已 supersede）** 曾写 Multi-unit → per-unit independent tab strips。**现行**：全局 session tab row 承载 openTabs；见 [`progress/shell-global-tab-bar.md`](./progress/shell-global-tab-bar.md)。多 unit 布局 / 多坞独立性验收仍有效。
10. **R4** Window min/max/close stay on a **fixed caption** layer (not inside any tab strip).
11. **R4** Switching session tabs does **not** fold/close the right dock.

---

## 6. Dispatch rules

- Max **8** agents per round.
- File ownership as in agent tables — no two agents edit the same file in one round.
- Agents write Chinese comments consistent with repo; UTF-8 only.
- After each round: orchestrator integrates, typecheck, smoke, then next round.

---

## 7. Progress log

| Round | Status | Notes |
|-------|--------|-------|
| R1 | **done** | Binding + per-unit dock + chrome toggle + min-size（A1–A8 已落地） |
| R2 | **done** | Unit chrome redesign + tool drag-split + openTool 按 session 作用域（B1–B8 主体） |
| R3 | **done** | Interactive PTY（C1–C8） |
| R4 | **in progress** | Multi-unit + 窗口三键固定；切 tab 不折叠右坞；（标签条主 UI → 全局一行，见 progress note） |
| R5 | pending | Hardening / residual QA |

### 2026-07-29 — Tab bar primary UI（docs）

- **Supersede：** 以 per-leaf / multi-strip 为 **primary** 会话标签 UI 的 R4 表述。
- **现行规格：** [`progress/shell-global-tab-bar.md`](./progress/shell-global-tab-bar.md) — 全局 session tab row、unit chrome 身份+快捷+最右 dock、等宽 tab、多窗 `openTabs` 隔离、新对话仅 `openNewDraftTab`。

### R1 agent status (2026-07-27) — **round complete**

| Agent | ID | Status | Notes (from code / dispatch) |
|-------|-----|--------|------------------------------|
| A1 | `session-leaf-invariant` | **done** | `store/layout-tree/conversationUnit.ts` + tests |
| A2 | `session-drag-idempotent` | **done** | `useTopBarDrag` + `useTopBarDrag.sessionDrop.test.ts`：已有 leaf → move/focus，不 clone |
| A3 | `dock-per-unit-project` | **done** | `adapterShape.ts` 按 session unit 投影；`adapterShape.test.ts` / `multiUnitDock.test.ts` |
| A4 | `tab-lifecycle-bind` | **done** | `activateTab` / `closeTab` 绑 unit + kill PTY；`conversationUnitBinding.test.ts` |
| A5 | `unit-chrome-dock-toggle` | **done** | 右坞开关在 `ChatHeader`；`AppTopBar` trail 仅 help + window |
| A6 | `min-size-no-overlap` | **done** | `treeResizeClamp.ts` `MIN_CHILD_PX = 240` |
| A7 | `unit-tests-binding` | **done** | layout-tree / workspace-shell 绑定与 dock 测 |
| A8 | `docs-sync` | **done** | 本计划 + `analysis/shell_workspace_redesign.md` |

**R1 目标对照（产品）** — 已满足 binding/dock/chrome；交互式 PTY 归 R3。

### R2 agent status (2026-07-27) — **round complete**

| Agent | ID | Status | Notes |
|-------|-----|--------|-------|
| B1 | `unit-chrome-redesign` | **done** | `ChatHeader` 工具打开 + dock toggle |
| B2 | `tool-tab-drag` | **done** | `RightToolDockHeader` + `useToolDockTabDrag` / `toolDockTabOrder` |
| B3 | `tool-open-scoped` | **done** | `openToolInSession` 按 unit session |
| B4–B6 | tool owner / drop / css | **done** | `dropDetection` unit-scope；样式 polish |
| B7 | `integration-tests-ui` | **done** | `multiUnitDock.test.ts` 等 |
| B8 | `verify-typecheck` | **done** / 由集成轮复核 | 定向 vitest 绿 |

### R3 agent status (2026-07-27) — **round complete**

| Agent | ID | Status | Notes |
|-------|-----|--------|-------|
| C1 | `rust-pty-session` | **done** | Tauri PTY create/write/resize/kill + output events |
| C2 | `frontend-pty-bridge` | **done** | `ptySessionApi` + session manager |
| C3 | `terminal-card-xterm-stdin` | **done** | Interactive xterm stdin |
| C4 | `assistant-shell-mirror` | **done** | Mirror only; no PTY hijack |
| C5 | `terminal-lifecycle` | **done** | open ensure / close kill; multi-PTY |
| C6 | `pty-tests` | **done** | Frontend contract + Rust unit |
| C7 | `terminal-docs` | **done** | Operator doc |
| C8 | `e2e-smoke` | **done** | Smoke checklist |

**R3 代码入口**

| 层 | 路径 |
|----|------|
| Rust PTY | `apps/agent-workbench/src-tauri/src/pty/` |
| 前端 API | `apps/crish-desktop/src/api/ptySessionApi.ts`, `ptyRegistry.ts` |
| UI | `TerminalCard` + xterm stdin |

### R4 agent status (2026-07-27) — **in progress**

| Agent | ID | Status | Notes |
|-------|-----|--------|-------|
| D1 | `dock-focus-no-project` | **pending** | 去掉 focus 路径 `applyDockToTree` |
| D2 | `tab-strip-placement` | **pending** | session → unit 条带归属/顺序 |
| D3 | `per-unit-tabstrip` | **pending** | 每 unit 独立 TabStrip |
| D4 | `caption-win-buttons` | **pending** | AppTopBar 固定 caption + 三键 |
| D5 | `cross-strip-tab-drag` | **pending** | 条带间拖 = move unit |
| D6 | `css-obsidian-strips` | **pending** | 圆角分组标签 + 几何对齐 |
| D7 | `tests-tab-dock` | **pending** | 切 tab 不改坞；多 strip 几何 |
| D8 | `docs-r4-accept` | **pending** | 本文档 + 验收清单 |

**R4 验收要点**：multi-unit 双标签条；窗口按钮固定层；切 tab 不折叠右坞。

---

## 8. Round 4 增补 — Obsidian 式分屏顶栏（用户 2026-07-27 反馈）

参考截图：Obsidian 左右分栏时，**每个 pane 顶部各自一条标签行**；窗口右上角 min/max/close 是**固定层**，不隶属某一条标签行。

### 8.1 现象与根因

| ID | 现象 | 根因 |
|----|------|------|
| U9 | 分屏后顶栏仍是**共用一条**会话标签行 | `AppTopBar` → `UnifiedTopBar` 全局 `TopBarChatZone`；leaf 不拥有 TabStrip |
| U10 | 切换顶部对话标签时，该对话的**右侧坞会折叠/关掉** | `activateTab` 里无条件 `applyDockToTree(tab.rightDock, sessionId)`：焦点切换被当成「重新投影坞」。产品规则：**坞开闭只由该对话 unit 的侧栏按钮（及开/关工具）决定，与切标签无关** |
| U11 | 窗口三键像嵌在标签行里 | 整行 flex：`rail \| tabs \| trail`；单条标签时尚可「融入」，多 unit 分条后必须改成**固定 caption 层** |

### 8.2 目标结构（对齐 Obsidian）

```
┌─ 固定应用 caption ──────────────────────────────────────────┐
│ [侧栏折叠]                                    [帮助][─][□][×] │  ← 三键固定右上，不在任何标签行内
├─ Unit A 标签行 ──────────────┬─ Unit B 标签行 ──────────────┤
│ [会话A][会话C][+]            │ [会话B][+]                    │  ← 每个分屏列独立标签条
├─ Unit A 工具栏 / 右坞开关 ───┼─ Unit B 工具栏 / 右坞开关 ───┤
│ 对话体 | 可选右坞            │ 对话体 | 可选右坞             │
└──────────────────────────────┴──────────────────────────────┘
```

规则：

1. **N 个 conversation unit → N 条标签行**，横向对齐各 unit 的 x/width（flatten 后的 chat unit 几何）。
2. **单 unit**：可保留主区一条标签行，但 caption 仍固定（三键不进标签条）。
3. **activateTab / 点标签**：只做 `activeTabId` + `setActiveSessionId` + `setActiveLeaf`；**禁止**因聚焦调用 `applyDockToTree`。投影仅发生在：坞按钮切换、打开/关闭工具、改宽度、冷启动恢复。
4. **窗口控件**：固定 caption / overlay，标签行再宽也不挤掉三键。
5. **左栏折叠**：仍全局，不 per-unit。

### 8.3 R4 实施切分（≤8 agent）— **in progress**

| Agent | 任务 | Status |
|-------|------|--------|
| D1 | 去掉 focus 路径上的 `applyDockToTree`；仅 dock 变更写树 | pending |
| D2 | 放置模型：session 归属哪个 unit / 条带内顺序 | pending |
| D3 | 每 unit 渲染独立 TabStrip（几何对齐 flatten rect） | pending |
| D4 | AppTopBar 收敛为 caption：侧栏 + 拖拽区 + 帮助 + 窗口键；多 unit 时不下沉全局会话条 | pending |
| D5 | 条带间拖标签 = move unit（复用 planSessionCanvasDrop / moveLeaf） | pending |
| D6 | CSS：Obsidian 式圆角分组标签 + 与 unit 对齐 | pending |
| D7 | 测：切 tab 不改变邻居坞；多条 strip 几何 | pending |
| D8 | 文档与对照 Obsidian 截图的验收清单 | pending |

### 8.4 与 R1–R3 的关系

- 右坞状态仍 per-`TabSurface.rightDock`（R1–R2）；R4 修的是**投影触发时机**与**标签几何**。
- PTY 仍 closeTab 才 kill（R3）；切标签不杀 PTY、不关坞。
