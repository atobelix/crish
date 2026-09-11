# Conversation Unit Shell — 现状审计与最终优化方案

| Field | Value |
|-------|-------|
| Date | 2026-07-28 |
| Scope | `apps/crish-desktop` + Tauri PTY |
| Input | 当前代码实态 + 5 路只读子 Agent 审查 |
| Status | **方案定稿** — 待按波次实施 |
| Baseline plan | `docs/plans/2026-07-conversation-unit-shell.md` |

---

## 0. 一句话结论

**R1–R3 与 R4 主体（caption、per-unit 标签条、多 unit focus 不投影坞）已在代码中落地；文档严重滞后。**
真缺口不在「从零做 R4」，而在：

1. **全局 tool 折叠 / 投影拍扁 tool 子树**（多 unit 正确性）
2. **PTY 生命周期双 spawn + 死绑定 + Terminal 未绑 leaf session**
3. **D5 条带拖拽未接 UI**；`updateRightDock` 仍偏 active-tab
4. **测试/死代码/文档漂移**；性能订阅偏粗

---

## 1. 当前代码实态（相对原计划）

### 1.1 已落地（文档仍标 pending 的部分）

| 能力 | 锚点 |
|------|------|
| AppTopBar = caption only（侧栏 + 窗键） | `AppTopBar.tsx` |
| N unit → N 条 `UnitSessionTabStrip` | `TreeLeafPanel` + `UnitSessionTabStrip` — **代码曾落地**；**主 UI 决策已 supersede** 为全局 session tab row，见 [`progress/shell-global-tab-bar.md`](./progress/shell-global-tab-bar.md) |
| 条带归属模型 | `store/workspace-shell/unitTabPlacement.ts`（随 global tab row 收敛时再评估） |
| 多 unit `activateTab` 不 `applyDockToTree` | `workspaceShellStore.activateTab`（`chatCount > 1`） |
| closeTab 摘 UnitRoot + kill PTY | `removeSessionUnitFromTree` + `ptyRegistry` |
| per-session `applyDockToTree` | `adapterShape.ts` |
| 工具 tab 坞内拖 / unit 内 split | `useToolDockTabDrag` + `RightToolDockHeader` |
| ChatHeader 坞开关 / openTool 按 session | `ChatHeader` + `openToolInSession` |
| ConPTY + xterm stdin 协议已通 | `pty/*` + `TerminalCard.xterm` |
| store 层 U10 / multi dock 测 | `focusDockIsolation` / `multiUnitDock` / 等 |

### 1.2 未闭环 / 结构性偏差

| 偏差 | 说明 |
|------|------|
| 标签条几何 / 主 UI | strip 挂在 **chat leaf** 的几何债仍在；**产品主路径** 已定为 **全局 session tab row**（非 per-leaf Obsidian multi-strip）— [`progress/shell-global-tab-bar.md`](./progress/shell-global-tab-bar.md) |
| 全局 `toolColumnCollapsed` | flatten 可把 **所有** tool 压成 0 宽 → 折 B 坞可能藏 A 的 tool |
| 投影拍扁 tool 子树 | `expandSessionUnitDock` 把 tool 侧换成 **单** `makeToolLeaf` → openTool 毁 split |
| 单 unit 切 tab | `chatCount <= 1` 仍 focus 投影 → 可关坞（与 U10 字面冲突） |
| `updateRightDock` | 仅 active tab 投影 → 非活动 unit 关工具 tab 树不同步 |
| D5 | `UnitSessionTabStrip` **click-only**；`useTopBarDrag` 只挂在已死的 `UnifiedTopBar` |
| Terminal | 只读全局 `activeSessionId`；xterm **再** `ptyCreate`，与 registry ensure 双开 |
| 死代码 | `UnifiedTopBar` / `TopBarChatZone` / `TopBarToolZone` 未挂载 |
| 文档 | plan R4 表全 pending；redesign 仍像停在 R1 |

---

## 2. 五路子 Agent 方案摘要

| Agent | 主题 | 核心结论 |
|-------|------|----------|
| A1 架构 | shell / layout / dock | 优先修 `toolColumnCollapsed`、投影保留 tool 子树、`updateRightDock` 按 session、Terminal session 注入 |
| A2 UX | chrome / 条带 / 拖拽 | D5 接通 strip；D1 收尾（单 unit 也不因 focus 关坞）；chat/tool 顶栏对齐；清死代码 |
| A3 PTY | 终端生命周期 | 统一 ensure 单入口；unmount 策略 A（折坞不杀）+ registry take；leafSessionId；exit kill_all |
| A4 性能 | render / stream | strip 订阅过宽；sash memo 失效；悬空 fuzz 测试；tool 流仍写 immer session |
| A5 测试债 | R4/R5 测试与文档 | 文档闭环 + D5 决策 + 几何/组件测 + 持久化策略 = R5 主战场 |

---

## 3. 统一问题清单（去重后）

### P0 — 正确性 / 泄漏 / 产品主路径

| ID | 问题 | 主要文件 |
|----|------|----------|
| **P0-1** | 全局 `toolColumnCollapsed` + flatten 隐藏全部 tool → 多 unit 折坞串扰 | `adapterShape`、`BinaryTreeWorkspace`、`layout-tree` flatten |
| **P0-2** | `expandSessionUnitDock` 投影拍扁 tool 子树 | `adapterShape.ts` ~207–210 |
| **P0-3** | PTY：`ensure` + xterm `ptyCreate` 双 spawn → 孤儿进程 | `openTool` / `ptyRegistry` / `TerminalCard.xterm` |
| **P0-4** | PTY：unmount 裸 kill 不解绑 → 死绑定；折坞无法续会话 | `TerminalCard.xterm` cleanup |
| **P0-5** | Terminal 未绑 `leafSessionId`，多 unit 串台 | `TreeLeafPanel` → `TerminalCard` |
| **P0-6** | D5 会话条无拖拽（产品分屏主入口断） | `UnitSessionTabStrip` / `useTopBarDrag` |

### P1 — 一致性 / 体验

| ID | 问题 |
|----|------|
| **P1-1** | `updateRightDock` 仅 active 投影 |
| **P1-2** | 单 unit `activateTab` 仍 focus 投影（U10 收尾） |
| **P1-3** | `applyDock` 副作用 `setActiveLeaf(tool)` 抢焦点 |
| **P1-4** | chat strip 32px vs tool header 30px 不对齐 |
| **P1-5** | shell `rightDock` / multi-unit 持久化未闭环 |
| **P1-6** | Unit strip 订整 `openTabs` + `tree.root`（N 分屏 O(N) re-render） |
| **P1-7** | cwd 进 xterm effect 依赖 → 改工作区杀壳 |

### P2 — 债 / 打磨

| ID | 问题 |
|----|------|
| **P2-1** | `UnifiedTopBar*` 死代码；`useTopBarDrag` 入口悬空 |
| **P2-2** | plan / redesign / binding 测试注释漂移 |
| **P2-3** | fuzz 依赖已删 `IncrementalMarkdownParser`；空 `sessionDiskMirror/` |
| **P2-4** | sash/controller memo 失效；BTW 订 past/future 死代码 |
| **P2-5** | strip a11y / overflow fade 未接线 |
| **P2-6** | tool 密集 run 仍 48ms 写 session immer |
| **P2-7** | PTY Job Object / 输出 backpressure / 文档 stdin 表述过时 |

---

## 4. 最终实施路线（推荐）

> 原则：先正确性，再交互闭环，再持久化/性能，最后 a11y 与文档出门。
> 约束：每波 ≤8 agent；文件所有权不交叉。

### 波次 S0 — 止血（1–2 人日）**立即**

| # | 任务 | 量 | 验收 |
|---|------|----|------|
| S0.1 | multi-unit：**禁止**全局 `toolColumnCollapsed` 藏 per-session tool；或 flatten 忽略有 `sessionId` 的 tool 折叠 | M | A 开坞、折 B → A tool 仍有 rect |
| S0.2 | `updateRightDock` **始终** `applyDockToTree(dock, sessionId)` | S | 非 active unit 关最后 tab → 该 unit 折叠 |
| S0.3 | PTY 统一 ensure：xterm 复用 registry；rebind 先 kill 旧 id | S | 开终端只 1 个 pwsh |
| S0.4 | kill 全走 take/registry；unmount **策略 A**：不 kill（仅 closeTab kill） | S | 折坞再开续同一 ptyId |
| S0.5 | `TerminalCard` 接收 `sessionId={leaf.sessionId}` | S | 双 unit 双终端不串 |
| S0.6 | 修悬空 fuzz / 空目录；修 binding 过时注释 | S | 相关测可解析 |

### 波次 S1 — 投影与 focus 语义（1–2 人日）

| # | 任务 | 量 | 验收 |
|---|------|----|------|
| S1.1 | `expandSessionUnitDock`：**sync tabs**，不替换已 split 的 tool 子树 | L | split 后 openTool 不毁布局 |
| S1.2 | `activateTab` **去掉** focus 路径投影（含单 unit）；投影仅坞按钮/openTool/恢复 | S | 单 unit A 坞开 → 切 B → 回 A 仍开（元数据+树） |
| S1.3 | `applyDockToSession` 默认不抢 `setActiveLeaf(tool)` | S | 背景 unit 开工具不抢焦点 |
| S1.4 | 对称测：multi 不投影 / 显式 update 仍投影 | S | vitest |

### 波次 S2 — D5 与 chrome（1.5–2.5 人日）

| # | 任务 | 量 | 验收 |
|---|------|----|------|
| S2.1 | `UnitSessionTabStrip` 接入 session drag（复用 `planSessionCanvasDrop`） | L | 同条 reorder；跨条/画布 move 不 clone |
| S2.2 | tool 列顶 spacer 对齐 strip（短期几何） | S–M | ChatHeader 与 RightToolDockHeader 同水平线 |
| S2.3 | 删除或归档 `UnifiedTopBar` / `TopBarChatZone` / `TopBarToolZone` | S | 无死入口；`useTopBarDrag` 迁到 hooks 或 unit strip |
| S2.4 | 更新 plan R4 D1–D8 真实 status + D8 手测清单 | S | 文档 = 代码 |

### 波次 S3 — 持久化 multi-unit（2–3 人日）

| # | 任务 | 量 | 验收 | Status |
|---|------|----|------|--------|
| S3.1 | 产品决策：cold start `clean` vs `restore` multi | S | 文档 ADR | **done** — `multi-unit-layout-restore-adr.md` |
| S3.2 | restore：按 **每个** tab 的 `rightDock` 从树 infer（勿默认 collapsed 投影） | M | 往返双 unit 双坞 | **done** — `syncShellDocksFromTree` |
| S3.3 | 测矩阵：clean 单 chat；restore multi；corrupt→clean | M | 自动化锁 | **done** — `hydrateWorkspaceShell.test` + `layoutRestorePolicy.test` |

### 波次 S4 — 性能与 a11y（2–4 人日，可与 S3 并行部分）

| # | 任务 | 量 | Status |
|---|------|----|--------|
| S4.1 | strip 窄订阅（本 unit tabs 投影，不订整 openTabs/root） | M | **done** — `openTabsStripRelevantEqual` / `chatUnitsEqual` + `UnitSessionTabStrip.subscribe.test` |
| S4.2 | sash controller 稳定 + 去掉 BTW 无用 history 订阅 | S | **done** — `TreeResizeSash` memo + BTW 不订 past/future |
| S4.3 | live resize：缓存 DOM map / 仅 paint 受影响子树 | M | **部分完成 (W6-7)**：`collectLiveResizeDomMap` 手势期缓存 leaf/sash；每帧 Map 命中；cleanup 清缓存。未做「仅 paint 受影响子树」。 |
| S4.4 | 流式双订阅合并；tool 流轻量 store（可选 L） | M–L | **partial → 近 done**：W5-1 tool lite store 已落地；**OPT-7** row/content 双 streamText 合并（thinking@row / body useShallow@MessageContent）；residual：list pin 双订 full messages、ChatCard 散订。纪要 `wave4-6-perf-notes.md` §8 |
| S4.5 | strip 键盘 roving + overflow `data-overflow-*` | S | **done (W6-7)** — roving tabindex + Arrow/Home/End/Delete；`data-overflow-start/end` + `readStripOverflow`；`UnitSessionTabStrip.a11y.test` |
| S4.6 | PTY：Job Object、exit `kill_all`、cwd 不默认杀壳 | M | **基本完成 (W4-4 + W6-2)**：exit `kill_all`（Rust `RunEvent::Exit` → `kill_all_sessions`；FE pagehide/bootstrap → `compositionRoot.pty.killAll`）；**W6-2** PTY 自有 Job Object（Windows）。cwd 不默认杀壳保持策略。跨平台/残余孤儿策略若需再迭代可开 residual。 |

### 波次 S5 — 出门 QA（1–2 人日）

1. plan §5 验收 1–11 + R4 三条（双 strip / caption / 切 tab 不关坞）
2. 双 unit 双 PTY；反复开闭终端 20 次无进程泄漏
3. 工具 split + openTool 不毁布局
4. typecheck + `workspace-shell` / `layout-tree` / `pty*` / `binary-tree` vitest
5. tauri-mcp 手测清单（见下）
6. plan / redesign 标 **R4 done / R5 done**（或 R5 partial）

---

## 5. 产品决策点（实施前需拍板）

| # | 决策 | 建议默认 |
|---|------|----------|
| D-A | 单 unit 多 tab：切 tab **是否**同步该 tab 的 rightDock 到树？ | **否**（切 tab 永不 reproject；坞状态按 session 保留，显式开关才改树） |
| D-B | 折坞 / 切走 terminal 面板：PTY 杀还是挂起？ | **策略 A：挂起不杀**；仅 closeTab / reset kill |
| D-C | D5 是否必须本迭代？ | **是**（否则分屏只能靠侧栏，与 Obsidian 目标差一截） |

### 2026-07-29 — 会话标签主 UI（已拍板，shell track）

| 项 | 决定 |
|----|------|
| 主标签条 | **全局** session tab row（**非** per-leaf multi-strip 为主） |
| Unit chrome | 项目名或「对话」+ shortcuts；**dock toggle 最右** |
| Tab 宽度 | **uniform** |
| 多窗 | `openTabs` **按窗隔离** |
| 新对话 | 仅 `openNewDraftTab` / enterDraft |

全文决策记录：[`progress/shell-global-tab-bar.md`](./progress/shell-global-tab-bar.md)。本 residual 中「N unit → N strip / Obsidian 列顶栏」作 **历史实现与几何债** 理解，实施时以该 progress note 为准收敛。
| D-D | 冷启动 multi-unit restore？ | **先 clean 单 chat 安全默认**；restore = `ui.restoreLastWorkspace` opt-in + 树校验（见 `docs/architecture/multi-unit-layout-restore-adr.md`） |
| D-E | strip 几何是否必须跨 chat+tool 整列？ | **本迭代 spacer 对齐即可**；整列 strip 列为后续 L |

---

## 6. tauri-mcp / 手测清单（浓缩）

1. Caption：`.app-top-bar` 有窗键，无 `right-dock-toggle`，无 `.unified-top-bar`
2. 单 chat：1 条 `[data-unit-session-tab-strip]`
3. 分屏两会话：2 条 strip，不同 `data-leaf-id`
4. A 开终端坞，B 开 files 坞 → 折 B → **A 终端仍在**（P0-1）
5. A 工具 tab split 后再开 overview → **split 仍在**（P0-2）
6. 切 strip 标签：坞不因 focus 关（S1.2）
7. 双 unit 双终端：键入不串；关 B tab 只杀 B 的 shell
8. 开终端：任务管理器仅 **一个** pwsh/session；折坞再开 **同进程**（P0-3/4）
9. D5 后：同条重排；拖到侧 split 不 clone；再拖同一 session → activate only

---

## 7. 工作量粗估

| 范围 | 人日 |
|------|------|
| S0 止血 | 1–2 |
| S1 投影语义 | 1–2 |
| S2 D5 + chrome | 1.5–2.5 |
| S3 持久化 | 2–3 |
| S4 性能/a11y/PTY 加固 | 2–4 |
| S5 QA | 1–2 |
| **最小可交付**（S0+S1+S2 核心+S5 轻） | **约 5–8** |
| **完整 R5**（含 S3/S4） | **约 9–15** |

---

## 8. 非目标（本方案仍不做）

- 替换 BinaryTree 布局引擎
- OS 多窗口 / 完整 VS Code grid
- 改 daemon chat 协议
- 完整 scrollback 跨重启持久化 / 沙箱 seccomp
- 把所有 oneshot shell 立刻废弃

---

## 9. 建议下一步

1. 用户确认 **§5 决策 D-A～D-E**（可用默认）。
2. 启动 **波次 S0**（多 agent ≤6）：P0-1～P0-5 + 测试注释。
3. 合入后跑 vitest + tauri-mcp 清单 1–8。
4. 再开 **S1 → S2（D5）→ S3/S4 → S5**。

---

*本文件由 2026-07-28 多 Agent 只读审计汇总，作为后续实施真源；原 `2026-07-conversation-unit-shell.md` 应在 S2.4 同步 status。*
