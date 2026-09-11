# Optimization Wave Dispatch Board（OPT-1…OPT-9 · OPT-B · OPT-C · OPT-D · OPT-E · OPT-F · OPT-G · OPT-H）

**For:** human orchestrator + parallel agents
**Date:** 2026-07-29
**真源:** `system-control-ledger.md`
**Primary track:** **Optimization**（架构清晰 / 功能去重 / 样式统一 / 性能 / 外部会话导入）
**Paused as primary:** unified E0/live MCP test close-out（E0 仍 **partial** 直至 send 在 daemon 重启后 re-verify；不阻塞优化波）

> **状态（2026-07-29）：**
> - **OPT-A（OPT-1…OPT-9 + HOTFIX-1）** — **complete / landed**
> - **OPT-B（B1…B7）** — **complete / landed**（import 31 tests、draft-only、CSS Diff/Approval/ToolCall、navigation-keys、InlineAgentPanel MD、sendTerminateDualWire flag、system-map-clear）
> - **OPT-C（C1…C8）** — **complete / landed**（layout ownership partial docs、empty-shell vs draft、transport daemon primary + flag、shell/models/panels tokens、import soft-dedup importMeta、streamStop helper、docs、FirstRunWizard test fix）
> - **OPT-D（D1…D8）** — **complete / landed**（providerProfiles tests、BinaryTree/tab-drag tokens、tree facade、Tooltip SoT、settings tokens、import custom roots、docs、chat pin `allMessages` prop）
> - **OPT-E（E1…E9）** — **complete / landed**（chat/provider/settings CSS residual §12–14；setAppSettings + sidebar + openAgentPanel → compositionRoot；docs purge #8；ownershipEnforce + compositionRoot tests）
> - **OPT-F（F1…F8）** — **complete / landed**（CSS residual §15–16；useStreamCallbacks/drag/tree/chatHandlers → root；transport degraded metric + one-shot console；system-map + inventory + composition docs）
> - **OPT-G（G1…G8）** — **complete / landed**（CSS final residual ~15→0；agent/slash/tool/header/session/layout facades → root；pin/archive/branch facade；dead dual-path delete；post-G hotfix `tsc -b desktop` 0 errors）
> - **OPT-H（H1…H8）** — **complete / landed**（FirstRunWizard CSS hex→0；TSX inline hex ~52→0 high-traffic；stream setState residual **documented**（no patchState）；mcpBridge→compositionRoot；kill-list G3–G7 **done**；import/wizard 66 tests + hasCustomImportRoot UX；system-map pin/archive facade）
> - 旁路：W9 hydrate fork **fixed**；W10 multi-unit **PASS**；W10 send schema **HOTFIX-1**，**需 daemon 重启 re-verify**（**勿**标 live send PASS）；E0 **still partial**

---

## Direction（用户定调）

| 原则 | 说明 |
|------|------|
| **优化优先** | 产品清晰度、去重、样式与性能先做；统一测试关口后置 |
| **架构必须清晰** | 入口、边界、compositionRoot、session/shell/run-control 可读可指 |
| **功能去重** | 同能力多路径合并；禁止并行两套 UX/API |
| **样式统一** | token / 壳层 chrome / 设置与 wizard 视觉一致 |
| **性能任意可取** | 不限死清单；有 ROI 即可（订阅收窄、流/tool lite、渲染 memo 等） |
| **控制面保留** | steer / followUp、L2/L3 Stop/Force、compositionRoot、tool stream lite **不得回退** |
| **外部导入** | Codex / Claude 路径公开已知；应用内检测；Settings + FirstRunWizard **点击** UX |
| **Agent 限制** | 本机 home 扫描可能被 agent 环境拦截；**产品运行时用 Tauri FS**，勿依赖 agent 本地扫盘验收 |

---

## Prior control plane — keep（do not re-implement / do not regress）

| Surface | Status | Notes |
|---------|--------|-------|
| W6-1 force / steer / followUp pi queue | **done** | soft inject 安全点 |
| W8-1 enqueueSteer soft default | **done** | |
| W8-3 send-while-running → follow_up | **done** | busy 不 abort |
| B1 / W7-5 / W7-8 Stop=L2 · Force=L3 | **done** | |
| W5-2 + W9-B3 compositionRoot | **done**（sidebar）；**OPT-5** layout facade + **OPT-9** cancel 再收口 | |
| W5-1 tool stream lite store | **done** | streamingStore tools |
| W8-2 expanded smoke 413 | **done** | 回归基线；优化波后可定向重跑，**非**主线 |
| HOTFIX-1 run-task `clientMessageId` | **done** | daemon validator 接受字段；send 待 daemon 重启 re-verify |

---

## Testing track snapshot（paused as primary — 事实归档）

| Gate / slice | Result | Doc |
|--------------|--------|-----|
| E0-1 invariants | **16 PASS** | `e0-invariants.md` |
| E0-2 typecheck | **0 err PASS** | `e0-typecheck.md` |
| W7-2 / W8-2 / W10-INT vitest | **239 / 413 / 197 core PASS** | wave5-6 / wave7-8 / wave10-integration |
| W9-MCP-1 I-DRAFT + hydrate sameRef | **PASS** | `e0-mcp-journey.md` |
| W9-MCP-2 Stop aria | **PASS**（store probe） | `e0-mcp-stop-shell.md` |
| W9-MCP-3 activate hydrate dual-view | **PASS** + **fork write fix** | `e0-mcp-hydrate.md` |
| W9-DATA SQLite/LS wipe | **FIXED** | `session-body-empty-gap.md` |
| W10 multi-unit（E0-5） | **PASS** — open-split fix 后 | wave9-10 / multi-unit MCP |
| W10-MCP-1 full send | **SKIP → schema fixed (HOTFIX-1)**；**需 daemon 重启后 re-verify**；未宣称 live send PASS | `e0-mcp-send.md` |
| E0 overall | **partial** | live model send 待 daemon 重启 re-verify；live stream Stop / full `check:desktop` 仍 open |

Wave 9–10 派发板：`wave9-10-dispatch-board.md`（测试主线暂停后仅作历史与 residual 索引）。

---

## OPT-A wave — results（**done**）

> 实施中 ID 与初版派发表目标有重排：以**落地事实**为准（下表）。初版「架构图 / 路径 detect 分项」能力已并入导入 ADR、去重 inventory、compositionRoot facade 等交付物。

| ID | Delivered | Status | Notes |
|----|-----------|--------|-------|
| **OPT-1** | **外部导入 · parsers + ADR**（初版 26 tests） | **done** | Codex/Claude 解析器、路径/检测 ADR；**OPT-B1 扩至 31 tests** |
| **OPT-2** | **外部导入 · Settings + FirstRunWizard 点击 UX** | **done** | 设置页 + 向导共享导入实现；点击流 |
| **OPT-3** | **功能去重 inventory top 10** | **done** | 去重清单 top 10（见 `architecture-dedup-inventory.md`；OPT-B 已回写 kill 进度） |
| **OPT-4** | **样式 · CSS tokens**（top bar / settings / empty） | **done** | 壳层 chrome + 设置 + empty 态；**OPT-B3** 续 Diff/Approval/ToolCall |
| **OPT-5** | **compositionRoot layout facade** | **done** | layout 组装经 compositionRoot facade |
| **OPT-6** | **大块死代码删除** — dual composer / dual settings | **done** | 双实现路径收口；单入口 |
| **OPT-7** | **stream dual-sub 4→2** | **done** | 流双订阅收窄（4→2）；perf ROI |
| **OPT-8** | **文档收口**（本板 + ledger） | **done** | 优化主线真源；测试暂停说明；波末结果回写 |
| **OPT-9** | **cancel 经 compositionRoot + useAgentPanel** | **done** | Stop/cancel 路径走 compositionRoot / panel hook；控制面 keep |

### 旁路 / 测试波联动（OPT-A 窗口内）

| ID | Delivered | Status | Notes |
|----|-----------|--------|-------|
| **HOTFIX-1** | run-task `clientMessageId` validator | **done** | daemon 接受 `clientMessageId`；解除 W10 send schema reject |
| **W9-MCP** | hydrate fork write fix | **done** | 与 W9-MCP-3 对齐 |
| **W10 multi-unit** | open-split fix 后 **PASS** | **done / PASS** | 原 NOT EXERCISED → PASS |
| **W10 send** | 原 SKIP；HOTFIX-1 后待 **daemon 重启 re-verify** | **blocked on restart** | **不**发明 live send PASS；E0 仍 partial |

---

## OPT-B wave — results（**complete** 2026-07-29）

> 在 OPT-A 之上的 **产品路径硬化 / 去重杀单落地**。不重开 E0 测试主线。

| ID | Delivered | Status | Notes |
|----|-----------|--------|-------|
| **OPT-B1** | **Import real Tauri FS** + parsers **31 tests** | **done** | 产品运行时 Tauri FS（`importFsHost`）；detect/map/parse 单测 31；非 agent 扫盘 |
| **OPT-B2** | **Session create draft only** | **done** | 用户新对话仅 `enterDraft` / `openNewDraftTab`；`createSessionAndOpenChat` **@deprecated** → enterDraft；kill #1 |
| **OPT-B3** | **CSS tokens** Diff / Approval / ToolCall | **done** | DiffCard、ApprovalAskCard、ChatToolCall(+header)、settings-base 去 hex fallback；见 `style-token-unification.md` §8 |
| **OPT-B4** | **navigation-keys → compositionRoot** | **done** | `hooks/keyboard/navigation-keys.ts` layout 快捷键走 `getCompositionRoot().layout`；kill #6 partial |
| **OPT-B5** | **system-map-clear.md** | **done** | 人类一页系统地图（进程 / 四控制面 / 主路径 / 禁双路径）；OPT-C7 再刷新事实 |
| **OPT-B6** | **InlineAgentPanel → AsyncMarkdownBlock** | **done** | completed MD SoT 统一 Rust async 路径；kill #5 product done |
| **OPT-B7** | **sendTerminateDualWire** + dual-wire flag | **done（helper）** | 唯一双线配对点；`TRANSITIONAL_DUAL_CANCEL_RUN_WIRE`；kill #3 partial / #4 flagged；删 dual body 仍 gated E0 live Stop |

### OPT-B 验收摘要

| Gate | Result |
|------|--------|
| Import 31 tests + real FS adapter | **done** |
| Draft-only new chat / deprecated shim | **done** |
| Diff/Approval/ToolCall token 无 hex fallback 真源 | **done** |
| navigation-keys compositionRoot | **done** |
| InlineAgentPanel completed → AsyncMarkdownBlock | **done** |
| Cancel dual wire 单 helper + flag 可关 | **done** |
| system-map-clear 存在并可导航 | **done**（C7 同步） |

---

## OPT-C wave — results（**complete** 2026-07-29）

> 在 OPT-B 之上的 **ownership / transport / tokens / import dedup / stop 共享 / 文档 / 测试修复**。不重开 E0 测试主线。

| ID | Delivered | Status | Notes |
|----|-----------|--------|-------|
| **OPT-C1** | **Layout identity ownership docs**（partial） | **done（partial land）** | package headers + `storeOwnership.ts` + store README + composition docs；kill #2 **partial**；call-site enforce residual |
| **OPT-C2** | **Empty-shell vs PENDING_DRAFT** mental model | **done** | new chat = draft only；empty shells = hydrate GC only；kill **#9 done** |
| **OPT-C3** | **Transport daemon primary** + `ALLOW_AUTO_DIRECT_FETCH_FALLBACK` | **done（partial land）** | production `streamViaDaemon`；direct fetch = degraded only；flag default `true` soft-deprecated；kill #10 **partial** |
| **OPT-C4** | **CSS tokens** shell / models / panels | **done** | shell-*、settings-models、panels 去 hex fallback；见 `style-token-unification.md` §9 |
| **OPT-C5** | **Import soft-dedup** via `importMeta` | **done** | key `source + sourceSessionId`；default `skip`；`reimport` opt-in；ADR §10 resolved |
| **OPT-C6** | **streamStop shared helper** | **done** | `api/streamStop`：`dispatchStreamStopCancel` + `markStreamingActive`；chat + agent 共用 L2/L3 wire；kill #3/#7 推进 |
| **OPT-C7** | **Docs refresh** | **done** | `system-map-clear` · `architecture-dedup-inventory` · 本板 · `system-control-ledger` |
| **OPT-C8** | **FirstRunWizard test fix** | **done** | 向导相关单测修复（不阻塞导入 UX） |

### OPT-C 验收摘要

| Gate | Result |
|------|--------|
| Layout ownership matrix 文档化 | **done（partial）** — residual call-site enforce |
| Empty-shell vs draft single model | **done** |
| Transport SoT + flag + cancel parity | **done（partial）** — flag 仍 true；metric/notice residual |
| shell / models / panels tokens | **done** |
| Import soft-dedup importMeta | **done** |
| streamStop 共享 helper | **done** |
| Docs 与代码事实一致 | **done** |
| FirstRunWizard tests | **done** |
| 控制面无回归 | **keep** |

---

## OPT-D wave — results（**complete / landed** 2026-07-29）

> full-prompt batch D1…D8 已落地。short-prompt 再派发曾 **aborted**（历史注记）。本 pass 为 OPT-D **closeout**；active wave → **OPT-E**（现已 complete）。

| ID | Delivered | Status | Notes |
|----|-----------|--------|-------|
| **OPT-D1** | **providerProfiles / FirstRunWizard seed tests align** | **done** | 单测与当前 providerProfiles / 配置轨对齐 |
| **OPT-D2** | **BinaryTree / tab-drag CSS tokens** | **done** | 去 hex fallback；见 `style-token-unification.md` §11（closed OPT-D2） |
| **OPT-D3** | **compositionRoot.tree facade** | **done** | `getState` + `setLeafSessionId`；hydrate 用 `root.tree`（kill #6 推进） |
| **OPT-D4** | **Tooltip single SoT** | **done** | `components/Tooltip/` 单路径 |
| **OPT-D5** | **settings-plugins / advanced / usage / extensions tokens** | **done** | 见 `style-token-unification.md` §10 |
| **OPT-D6** | **import custom roots** | **done** | `api/import/importRootSettings.ts` + ExternalSessionImport UX |
| **OPT-D7** | **Docs pass** | **done** | 本 closeout  supersede 早期 D7 派发表 |
| **OPT-D8** | **chat pin path subscription perf** | **done** | `ChatMessageList` `allMessages` prop（parent 传 messages；避 dual store sub） |

### OPT-D 验收摘要

| Gate | Result |
|------|--------|
| D1–D8 全表 | **complete / landed** |
| Short-prompt 再派发 | **aborted**（历史；full-prompt 为落地真源） |
| 控制面无回归 | **keep** |
| E0 live send | **勿**未 daemon 重启 re-verify 标 PASS |

**OPT-D 纪律（延续）：** 控制面 keep（steer / followUp / L2·L3 / compositionRoot / tool lite / streamStop）；dual cancel body 删仍 gated E0 live Stop；transport flag 翻 `false` 需 offline UX 产品化。

---

## OPT-E wave — results（**complete / landed** 2026-07-29）

> 在 OPT-D 之上：CSS residual surfaces、compositionRoot 继续收口（setAppSettings / sidebar / agent panel / workspace chrome）、docs kill #8、layout ownership call-site tests。不重开 E0 测试主线；**勿**标 live send PASS。

| ID | Delivered | Status | Notes |
|----|-----------|--------|-------|
| **OPT-E1** | **Docs close OPT-D + open OPT-E** | **done** | board / ledger / inventory 三件一致 |
| **OPT-E2** | **CSS tokens:** ChatStatusRibbons + ChatComposer + ChatMessageRow residual hex | **done** | ~29→0 hex；`style-token-unification.md` §12 |
| **OPT-E3** | **CSS tokens:** provider/accounts/toast/error/overview residual hex | **done** | ~46→0 hex；§13 |
| **OPT-E4** | **CSS tokens:** SettingsUI / sidebar / MCP / models / skills residual hex | **done** | ~36→0 hex；§14 |
| **OPT-E5** | **layout facade setAppSettings** + compositionRoot expand；AppBootstrap optional fallback | **done** | kill #6 推进；23 tests |
| **OPT-E6** | **sidebar command paths** → compositionRoot | **done** | kill #6 推进；15 sidebar tests |
| **OPT-E7** | **openAgentPanel** + workspaceChromeHooks → compositionRoot | **done** | kill #6 推进；openAgentPanel 45 tests |
| **OPT-E8** | **Docs purge kill #8：** stale `session-actions/` paths | **done** | docs-only；note `opt-e8-session-actions-docs-purge.md`；kill **#8 done** |
| **OPT-E9** | **Layout ownership call-site enforce tests**（kill #2 residual） | **done** | ownershipEnforce 11 new + compositionRoot 17 = **28 pass**；kill #2 推进 |

### OPT-E 验收摘要

| Gate | Result |
|------|--------|
| E1–E9 全表 | **complete / landed** |
| CSS residual E2–E4 | **done**（§12–14） |
| compositionRoot E5–E7 | **done**（setAppSettings / sidebar / openAgentPanel） |
| docs purge kill #8 | **done** |
| ownership enforce tests | **done**（28 pass） |
| 控制面无回归 | **keep** |
| E0 live send | **勿**未 daemon 重启 re-verify 标 PASS |

**OPT-E 纪律（延续）：** 同 OPT-D keep list；dual cancel body 删仍 gated E0 live Stop；transport flag 翻 `false` 需 offline UX 产品化。

---

## OPT-F wave — results（**complete / landed** 2026-07-29）

> 在 OPT-E 之上：CSS residual surfaces §15–16、stream/dock/tree/chat handlers → compositionRoot、transport degraded one-shot metric/notice、inventory + system-map + composition docs 刷新。不重开 E0 测试主线；**勿**标 live send PASS。

| ID | Delivered | Status | Notes |
|----|-----------|--------|-------|
| **OPT-F1** | **Docs close OPT-E + open OPT-F** | **done** | board / ledger / inventory 三件一致 |
| **OPT-F2** | **CSS residual A:** ModelDetailPanel + AuthConfigSection + UserViewDebugPanel + Workspace.module + SettingsUsage | **done** | ~23→0 hex；`style-token-unification.md` §15 |
| **OPT-F3** | **CSS residual B:** chat-markdown + ProjectPicker + RightToolDockHeader + SidebarContextMenus + OverviewCard + ModelPicker + ChatHeader | **done** | ~20→0 hex；§16 |
| **OPT-F4** | **useStreamCallbacks** → compositionRoot layout/session | **done** | kill #6 推进；14 chat-stream tests；layout.setState residual intentional |
| **OPT-F5** | **useToolDockTabDrag** + **useTopBarDrag** → compositionRoot | **done** | kill #6 推进；86 drag-related tests |
| **OPT-F6** | **useTreeResize** + **useChatHandlers** → compositionRoot | **done** | kill #6 推进；42 tests |
| **OPT-F7** | **Transport degraded path:** metric + one-shot console notice | **done** | kill #10 residual metric：**done**；`recordTransportDegradedDirectFetch` + `transport_degraded_direct_fetch`；flag **still true**（flip residual） |
| **OPT-F8** | **system-map + inventory + composition docs refresh** | **done** | OPT-F facts 回写 |

### OPT-F 验收摘要

| Gate | Result |
|------|--------|
| F1–F8 全表 | **complete / landed** |
| CSS residual F2–F3 | **done**（§15–16） |
| compositionRoot F4–F6 | **done**（stream / drag / tree+chatHandlers） |
| transport F7 metric/notice | **done**（flag stay true） |
| docs F8 | **done** |
| 控制面无回归 | **keep** |
| E0 live send | **勿**未 daemon 重启 re-verify 标 PASS |

**OPT-F 纪律（延续至 OPT-G）：** 同 OPT-E keep list；dual cancel body 删仍 gated E0 live Stop；transport flag 翻 `false` 需 offline UX 产品化；F7 keep `ALLOW_AUTO_DIRECT_FETCH_FALLBACK` true。

---

## OPT-G wave — results（**complete / landed** 2026-07-29）

> 在 OPT-F 之上：CSS 最终细残面、agent/slash/tool/header/session/layout facade 继续收口、窄范围死代码 / unused dual-path 扫描删除。不重开 E0 测试主线；**勿**标 live send PASS。

| ID | Delivered | Status | Notes |
|----|-----------|--------|-------|
| **OPT-G1** | **Docs close OPT-F + open OPT-G** | **done** | board / ledger / inventory 三件一致 |
| **OPT-G2** | **CSS final tiny residual:** TerminalCard + InlineAgentPanel + QuickOpen + ScheduledTasks + chat.css + settings-models residual | **done** | ~15→0 hex；FirstRunWizard residual **noted deferred** → OPT-H2 |
| **OPT-G3** | **useAgentStream** + **useSlashSend** → compositionRoot | **done** | kill #6 推进；new useSlashSend tests；stop/stream keep |
| **OPT-G4** | **openTool** + **layoutRestorePolicy** + **treePanelAccess** command paths → root | **done** | openTool same-store skip；layoutRestorePolicy cold-start tree via root；292 shell/tree tests |
| **OPT-G5** | **ChatHeader.tsx** + **useChatPanelSync** + **useGoalMode** → root | **done** | kill #6 推进 |
| **OPT-G6** | **SessionSyncService** + **workspaceLayoutStore** residual → root | **done** | kill #6 推进 |
| **OPT-G7** | **Expand session/layout facade:** pin / archive / branch（clear sidebar TODO） | **done** | SessionFacade pin/unpin/archive/unarchive/branch；sidebar menu wire；44 tests |
| **OPT-G8** | **Dead code / unused dual-path scan delete**（narrow, safe） | **done** | deleted dead dual paths（git/ unused api components）；SettingsUI Tooltip re-export removed |

### OPT-G post-land hotfix

| Item | Result |
|------|--------|
| useChatHandlers `runStreamingAssistant` arity | **fixed** |
| hydrate `setState` immer | **fixed** |
| message-identity mapped type | **fixed** |
| parseCodex toolCalls CF | **fixed** |
| `tsc -b` desktop | **0 errors** |

### OPT-G 验收摘要

| Gate | Result |
|------|--------|
| G1–G8 全表 | **complete / landed** |
| CSS residual G2 | **done**（~15→0；FirstRunWizard deferred H2） |
| compositionRoot G3–G7 | **done**（agent/slash/tool/header/session/pin-archive-branch） |
| dead dual-path G8 | **done** |
| post-G hotfix | **done**（`tsc -b desktop` 0 err） |
| 控制面无回归 | **keep** |
| E0 live send | **勿**未 daemon 重启 re-verify 标 PASS |

**OPT-G 纪律（延续至 OPT-H）：** 同 OPT-F keep list；dual cancel body 删仍 gated E0 live Stop；transport flag 翻 `false` 需 offline UX 产品化；keep `ALLOW_AUTO_DIRECT_FETCH_FALLBACK` true。

---

## OPT-H wave — results（**complete / landed** 2026-07-29）

> 在 OPT-G 之上：FirstRunWizard + 高流量 TSX inline hex 收口、layout setState residual **文档化**（choice B；**无 patchState / 无 god rewrite**）、mcpBridge → compositionRoot、kill-list 刷新（G3–G7 **done**）、import/wizard polish、system-map pin/archive。不重开 E0 测试主线；**勿**标 live send PASS。

| ID | Delivered | Status | Notes |
|----|-----------|--------|-------|
| **OPT-H1** | **Docs close OPT-G + open OPT-H** | **done** | board / ledger / inventory 三件一致 |
| **OPT-H2** | **FirstRunWizard.module.css residual hex** | **done** | hex → **0**（G2 deferred closed） |
| **OPT-H3** | **TSX inline hex residual high-traffic**（AgentTeamBoard、ModelConfigEditor 等）→ tokens | **done** | ~52→**0** high-traffic；Terminal **xterm ANSI** residual noted（out of token strip） |
| **OPT-H4** | **Document stream setState residual**（choice B；**no patchState / no god rewrite**） | **done** | note `opt-h4-layout-setstate-residual.md`；stream layout.setState **intentional residual** |
| **OPT-H5** | **mcpBridge / remaining command getState** → compositionRoot | **done** | kill #6 residual slice landed |
| **OPT-H6** | **Inventory/board kill-list refresh after G** | **done** | G3–G7 **done**（H6 初稿误标 in flight → **corrected DONE**）；H4 setState intentional residual |
| **OPT-H7** | **FirstRunWizard + import residual polish tests** | **done** | import/wizard **66 tests**；`hasCustomImportRoot` UX |
| **OPT-H8** | **system-map compositionRoot pin/archive methods** | **done** | pin/archive facade docs on system-map |

### OPT-H 验收摘要

| Gate | Result |
|------|--------|
| H1–H8 全表 | **complete / landed** |
| H2 FirstRunWizard CSS hex | **done**（→0） |
| H3 TSX inline hex high-traffic | **done**（~52→0；Terminal xterm ANSI residual） |
| H4 setState residual docs | **done**（intentional；no patchState） |
| H5 mcpBridge → root | **done** |
| H6 kill-list refresh | **done**（G3–G7 **done**） |
| H7 import/wizard tests + UX | **done**（66 tests；hasCustomImportRoot） |
| H8 system-map pin/archive | **done** |
| 控制面无回归 | **keep** |
| E0 live send | **勿**未 daemon 重启 re-verify 标 PASS |

**OPT-H 纪律 / residual（closed wave）：** dual cancel body 删仍 **gated** E0 live Stop（flag still transitional）；transport flag **stays true**（flip residual；offline UX 产品化后）；keep `ALLOW_AUTO_DIRECT_FETCH_FALLBACK` true；stream setState residual **intentional**（H4 documented）；Terminal **xterm ANSI** residual；E0 **still partial** — **no** live send PASS.

---

## Original plan map（归档 — 初版 8 格意图）

| 初版 ID | 初版目标 | 落地映射 |
|---------|----------|----------|
| OPT-1 架构清晰图 | 边界 / 主路径 | 部分并入 OPT-3 inventory + OPT-5 facade + 导入 ADR |
| OPT-2 功能去重 | 单入口 | **OPT-3** inventory + **OPT-6** dead dual 删除 |
| OPT-3 样式统一 | token / chrome | **OPT-4** CSS tokens |
| OPT-4 性能 ROI | 订阅/流 | **OPT-7** stream dual-sub 4→2 |
| OPT-5–7 外部导入 | detect + Settings + Wizard | **OPT-1** parsers/ADR/tests + **OPT-2** Settings+Wizard UX |
| OPT-8 文档 | board + ledger | **OPT-8** done（含本波末回写） |
| （增） | cancel composition | **OPT-9** |
| （增） | send schema | **HOTFIX-1** |

---

## Parallelism & order（已执行 — 归档）

```
OPT-1 (import parsers/ADR) ──► OPT-2 (Settings + Wizard UX)
OPT-3 (dedup inventory)  ── parallel
OPT-4 (CSS tokens)       ── parallel
OPT-5 (compositionRoot layout facade) ── parallel / 串行避开同文件
OPT-6 (dead dual delete) ── 对照 OPT-3 清单
OPT-7 (stream dual-sub 4→2) ── parallel（stream 窄改）
OPT-8 (docs)             ── 波初 + 波末
OPT-9 (cancel via compositionRoot) ── 控制面 keep
HOTFIX-1 (clientMessageId) ── 解锁 W10 send re-verify（需 daemon 重启）
```

---

## Codex / Claude import — product notes

| Topic | Guidance |
|-------|----------|
| Paths | 使用社区/产品**公开已知**路径（如用户目录下 `.codex` / `.claude` 会话或 history 布局；以实现时核对的公开文档为准，写入路径表） |
| Detect | 应用内 `exists` / list；**非** agent 工作区扫盘 |
| UX | Settings **与** FirstRunWizard 均要 **click** 导入；共享 core — **OPT-1/OPT-2 done** |
| Skills 已有路径 | Skills 已提示 `~/.codex/skills` / `~/.claude/skills` — **会话导入**是独立能力，勿与 skills 目录扫描混为一谈，可复用 FS helper |
| 验收 | 真机 Tauri；CI/agent 无 home 时 mark SKIP + 单测 mock FS（**OPT-B1：31 tests** 已绿） |

---

## Gate targets

### OPT-A end

| Gate | Target | Result |
|------|--------|--------|
| Import parsers/ADR | OPT-1 | **done**（B1 扩 **31 tests**） |
| Import UX | OPT-2 Settings + Wizard | **done** |
| Dedup | OPT-3 top 10 + OPT-6 dual delete | **done** |
| Styles | OPT-4 tokens（top bar / settings / empty） | **done** |
| compositionRoot | OPT-5 layout facade + OPT-9 cancel | **done** |
| Perf | OPT-7 stream dual-sub 4→2 | **done** |
| Control plane | steer/followUp/L2/L3/compositionRoot/tool lite **无回归** | **keep** |
| Send schema | HOTFIX-1 `clientMessageId` | **done**；live send 待 daemon 重启 |
| E0 / unified test | **仍 partial / 非本波主门** | multi-unit **PASS**；send re-verify pending |
| Docs | OPT-8 + ledger 注记 | **done** |

### OPT-B end

| Gate | Result |
|------|--------|
| B1–B7 全表 | **complete**（见上 OPT-B results） |
| Dedup kill #1 / #5 product | **done**；#3 partial / #4 flagged / #6 partial |
| 控制面无回归 | **keep** |

### OPT-C end

| Gate | Result |
|------|--------|
| C1–C8 全表 | **complete**（见上 OPT-C results；C1/C3 partial land 已记） |
| Dedup kill #9 | **done**；#2/#10 **partial**；#3/#7 经 streamStop 推进 |
| 控制面无回归 | **keep** |

### OPT-D end

| Gate | Target | Result |
|------|--------|--------|
| D1 providerProfiles / Wizard seed tests | 对齐当前配置轨 | **done** |
| D2 BinaryTree / tab-drag CSS tokens | 去 hex fallback | **done**（`style-token-unification.md` §11） |
| D3 compositionRoot.tree facade | getState + setLeafSessionId；hydrate | **done** |
| D4 Tooltip single SoT | `components/Tooltip/` | **done** |
| D5 settings-plugins/advanced/usage/extensions tokens | 去 hex residual | **done**（§10） |
| D6 import custom roots | `importRootSettings` + ExternalSessionImport UX | **done** |
| D7 docs | board + ledger + inventory | **done**（closeout supersede） |
| D8 chat pin subscription perf | `ChatMessageList` `allMessages` prop | **done** |
| Short-prompt re-dispatch | — | **aborted**（历史） |
| 不回退控制面 / 不伪标 E0 PASS | **hard** | **keep** |

### OPT-E end

| Gate | Target | Result |
|------|--------|--------|
| E1 docs close OPT-D + open OPT-E | board / ledger / inventory | **done** |
| E2 ChatStatusRibbons / Composer / MessageRow tokens | residual hex ~29→0 | **done**（§12） |
| E3 provider/accounts/toast/error/overview tokens | residual hex ~46→0 | **done**（§13） |
| E4 SettingsUI / sidebar / MCP / models / skills tokens | residual hex ~36→0 | **done**（§14） |
| E5 setAppSettings + compositionRoot expand + AppBootstrap | kill #6；23 tests | **done** |
| E6 sidebar command paths → compositionRoot | kill #6；15 sidebar tests | **done** |
| E7 openAgentPanel + workspaceChromeHooks → root | kill #6；openAgentPanel 45 tests | **done** |
| E8 docs purge session-actions paths | kill #8 | **done** |
| E9 layout ownership call-site enforce tests | kill #2；28 pass | **done** |
| 不回退控制面 / 不伪标 E0 PASS | **hard** | **keep** |

### OPT-F end

| Gate | Target | Result |
|------|--------|--------|
| F1 docs close OPT-E + open OPT-F | board / ledger / inventory | **done** |
| F2 ModelDetail / AuthConfig / UserViewDebug / Workspace / SettingsUsage tokens | residual hex ~23→0 | **done**（§15） |
| F3 chat-markdown / ProjectPicker / dock header / menus / cards / pickers tokens | residual hex ~20→0 | **done**（§16） |
| F4 useStreamCallbacks → compositionRoot layout/session | kill #6；14 chat-stream tests | **done** |
| F5 useToolDockTabDrag + useTopBarDrag → compositionRoot | kill #6；86 drag tests | **done** |
| F6 useTreeResize + useChatHandlers → compositionRoot | kill #6；42 tests | **done** |
| F7 transport degraded metric + one-shot console | kill #10 residual metric；flag stay true | **done**（flag flip residual） |
| F8 system-map + inventory + composition docs | OPT-F facts | **done** |
| 不回退控制面 / 不伪标 E0 PASS | **hard** | **keep** |

### OPT-G end

| Gate | Target | Result |
|------|--------|--------|
| G1 docs close OPT-F + open OPT-G | board / ledger / inventory | **done** |
| G2 CSS final tiny residual（TerminalCard / InlineAgentPanel / QuickOpen / ScheduledTasks / chat.css / settings-models） | residual hex ~15→0 | **done**（FirstRunWizard deferred H2） |
| G3 useAgentStream + useSlashSend → compositionRoot | kill #6；useSlashSend tests；stop/stream keep | **done** |
| G4 openTool + layoutRestorePolicy + treePanelAccess → root | same-store skip；cold-start tree；292 shell/tree tests | **done** |
| G5 ChatHeader + useChatPanelSync + useGoalMode → root | kill #6 | **done** |
| G6 SessionSyncService + workspaceLayoutStore residual → root | kill #6 | **done** |
| G7 Expand session/layout facade pin/archive/branch | SessionFacade + sidebar menu；44 tests | **done** |
| G8 Dead code / unused dual-path scan delete | git/ unused api；SettingsUI Tooltip re-export removed | **done** |
| post-G hotfix | useChatHandlers arity / hydrate immer / message-identity / parseCodex；`tsc -b desktop` 0 err | **done** |
| 不回退控制面 / 不伪标 E0 PASS | **hard** | **keep** |

### OPT-H end

| Gate | Target | Result |
|------|--------|--------|
| H1 docs close OPT-G + open OPT-H | board / ledger / inventory | **done** |
| H2 FirstRunWizard.module.css residual hex | hex → 0（G2 deferred） | **done** |
| H3 TSX inline hex residual high-traffic（AgentTeamBoard / ModelConfigEditor 等）→ tokens | ~52→0 high-traffic | **done**（Terminal xterm ANSI residual） |
| H4 Document stream setState residual（choice B） | **no patchState / no god rewrite** | **done**（`opt-h4-layout-setstate-residual.md`；intentional residual） |
| H5 mcpBridge / remaining command getState → root | kill #6 | **done** |
| H6 Inventory/board kill-list refresh after G | G3–G7 **done**（correct H6 mislabel） | **done** |
| H7 FirstRunWizard + import residual polish tests | 66 tests；hasCustomImportRoot UX | **done** |
| H8 system-map compositionRoot pin/archive methods | docs | **done** |
| 不回退控制面 / 不伪标 E0 PASS | **hard** | **keep** |

---

## Residual / next（非优化主线硬门）

1. **Daemon 重启后** re-verify W10 full send（HOTFIX-1 后）；通过前 E0 **仍 partial** — **no** live send PASS。
2. Live stream Stop（真实 token stream）仍 open。
3. 全量 `check:desktop` 非本波硬门。
4. Dedup residual：#2 layout enforce **E9 tests landed**（call-site residual may remain）；#3 full hook merge、#4 删 dual body **gated** E0 live Stop；#6 getState migrate（**D3 + E5–E7 + F4–F6 + G3–G7 done** + **H5 mcpBridge done**；**H4 stream setState intentional residual** + any leftover strip）；#8 docs purge **done（E8）**；#10 **F7 metric done**；**flag flip residual**（transport flag **still true**）。
5. **OPT-A…OPT-H complete / landed**。
6. Style residual：BinaryTree/tab-drag **D2 closed**；settings D5 **closed**；E2–E4 **closed**；F2–F3 **closed**（§15–16）；**G2 closed**（~15→0）；**H2 FirstRunWizard closed**（→0）；**H3 TSX high-traffic closed**（~52→0）；**Terminal xterm ANSI** residual（not token CSS）。

---

## Orchestrator checklist

1. ~~宣布 **optimization primary**；E0 live MCP **不**再并行抢写同一控制面文件。~~ **done**
2. ~~OPT 导入路径/解析先于 UI~~ — **OPT-1 → OPT-2 done**；**OPT-B1 31 tests**
3. ~~去重对照 inventory~~ — **OPT-3 + OPT-6 + OPT-B kill 落地** + **OPT-C** #9/#C5/#C6
4. 任何触及 `chat-stream` / run-control 的改动：保留 soft steer / follow_up / L2/L3；dual wire 仅经 `sendTerminateDualWire`；stop wire 经 `api/streamStop`。
5. 波末：定向 vitest 即可；全量 E0 后置。
6. 本机 home：产品 Tauri；agent 扫盘失败 **不**改写为产品 FAIL。
7. ~~OPT-B complete~~ → ~~**OPT-C complete**~~ → ~~**OPT-D complete**~~ → ~~**OPT-E complete**~~ → ~~**OPT-F complete**~~ → ~~**OPT-G complete**~~ → ~~**OPT-H complete**~~。
8. **下一步测试：** 重启 daemon → re-verify live send；**勿**在未 re-verify 前把 E0 标 done。
9. **OPT-H 真源：** 本板 H 表 + ledger + inventory — **closed / landed**。

**Out of closed OPT waves（明确非目标）：** 全量 `check:desktop` 作硬门、OTel e2e、进程外 Hook、conex-stream 生产接线、伪造 live model E0-4 PASS、未经验证关 `TRANSITIONAL_DUAL_CANCEL_RUN_WIRE` / `ALLOW_AUTO_DIRECT_FETCH_FALLBACK`、layoutStore god rewrite（H4 documented intentional residual）。
