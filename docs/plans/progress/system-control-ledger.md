# System Architecture Control — Progress Ledger

真源：`docs/plans/2026-07-system-architecture-control-master-plan.md`
更新日期：2026-07-29

> **主线切换（2026-07-29）：** **统一测试 / E0 关口暂停为 primary track**；**Optimization 为 primary**。
> - **OPT-A（OPT-1…OPT-9 + HOTFIX-1）** — **landed**
> - **OPT-B（B1…B7）** — **complete**：import 真 Tauri FS + **31 tests**；draft-only 新对话 / `createSessionAndOpenChat` deprecated；CSS Diff/Approval/ToolCall tokens；`navigation-keys`→compositionRoot；InlineAgentPanel→AsyncMarkdownBlock；`sendTerminateDualWire` + dual-wire flag；`system-map-clear.md`
> - **OPT-C（C1…C8）** — **complete**：layout ownership partial docs；empty-shell vs draft；transport daemon primary + `ALLOW_AUTO_DIRECT_FETCH_FALLBACK`；shell/models/panels tokens；import soft-dedup `importMeta`；`streamStop` shared helper；docs refresh；FirstRunWizard test fix
> - **OPT-D（D1…D8）** — **complete**：providerProfiles tests；BinaryTree/tab-drag tokens；`compositionRoot.tree`；Tooltip SoT；settings tokens；import custom roots；docs；chat pin `allMessages`
> - **OPT-E（E1…E9）** — **complete**：chat/provider/settings CSS residual §12–14；setAppSettings + sidebar + openAgentPanel → compositionRoot；docs purge #8；ownershipEnforce + compositionRoot tests（28 pass）
> - **OPT-F（F1…F8）** — **complete**：CSS residual §15–16；useStreamCallbacks/drag/tree/chatHandlers → root；transport degraded metric + one-shot console（flag stay true）；system-map + inventory + composition docs
> - **OPT-G（G1…G8）** — **complete**：CSS final residual ~15→0（FirstRunWizard deferred H2）；useAgentStream/useSlashSend/openTool/layoutRestore/ChatHeader/session sync/pin-archive-branch → root；dead dual-path delete；post-G hotfix `tsc -b desktop` 0 err
> - **OPT-H（H1…H8）** — **complete / landed**：FirstRunWizard CSS hex→0；TSX inline hex ~52→0 high-traffic；stream setState residual **documented**（choice B；no patchState）；mcpBridge→compositionRoot；kill-list G3–G7 **done**；import/wizard 66 tests + hasCustomImportRoot UX；system-map pin/archive facade
> **保留：** 控制面已成能力（steer / followUp、Stop L2 / Force L3、compositionRoot、tool stream lite、`api/streamStop`）— 优化波 **不得回退**。
> **E0 仍 partial** — multi-unit **PASS**（open-split）；send 原 SKIP，**HOTFIX-1** `clientMessageId` validator 已修，**待 daemon 重启后 re-verify live send**（**勿**标 live send PASS）。**Wave 8 全量 done**（W8-1 soft / W8-2 413 / W8-3 follow_up）。
> 派发板：[`optimization-wave-board.md`](./optimization-wave-board.md)（主）；历史测试波：[`wave9-10-dispatch-board.md`](./wave9-10-dispatch-board.md)。

| Round | Status | Notes |
|-------|--------|-------|
| A0 | **done** | 路径地图隐含在实施中 |
| A1 | **done** | shared-types: session-identity / message-identity / run-control + a1-contracts.test |
| A2 | **done** | createSessionAndOpenChat → enterDraft only；用户新建不 mint 空壳 |
| A3 | **done** | setActive hydrate；空壳 prune；侧栏 shouldList |
| B0 | **done** | ControlBus + session-loop 安全点 L1/L2/L3；max-turns 语义 |
| B1 | **done** | UI Stop=L2 / Force=L3；runControlClient；daemon run-control 接线 |
| B2 | **done** | LifecycleHookRegistry observe/on/emit；turn.start/end wire；docs/guides/hooks.md |
| B3 | **partial → 更近 done** | W5-2 compositionRoot 扩展 runControl / metrics / session；**W9-B3** sidebar「新对话」走 compositionRoot **done**；**OPT-5** layout facade **done**；**OPT-9** cancel via compositionRoot + useAgentPanel **done**；**OPT-B4** navigation-keys → compositionRoot.layout **done**；**OPT-D3** `compositionRoot.tree` facade **done**；**OPT-E5** setAppSettings + AppBootstrap **done**；**OPT-E6** sidebar command paths **done**；**OPT-E7** openAgentPanel + workspaceChromeHooks **done**；**OPT-F4–F6 done**（useStreamCallbacks / drag / tree+chatHandlers → root）；**OPT-G3–G7 done**（useAgentStream/useSlashSend/openTool/layoutRestore/ChatHeader/session sync/pin-archive-branch → root）；**OPT-H5** mcpBridge → compositionRoot **done**；**OPT-H4** stream layout.setState residual **documented intentional**（no patchState）。**仍非**全量去 getState（leftover strip may remain） |
| C0 | **done** | addMessage upsert by id；clientMessageId；hydrate mergeMessagesById；**W7-6** clientMessageId 端到端 stream 接线 |
| C1 | **done** | messageUserProjection + hidden buckets + debug flag |
| C2 | **done** | key=id 审计锁测；stream/final 同行（既有路径加固） |
| C3 | **done** | persist 拒 PENDING_DRAFT；hydrate prune |
| D0 | **partial → 更近 done** | 已：W4-3 strip 窄订阅 + sash memo；W4-7 死 TS md 路径 purge；**W5-1 tool stream lite store**；**D0-8 / W7-7 perf-report**；**OPT-7 stream dual-sub 4→2**；**OPT-B6** InlineAgentPanel → AsyncMarkdownBlock（product completed SoT）。仍 residual：fixture parity（W10-4）、conex-stream 评估 |
| D1 | **done** | dock 始终投影；focus 不 reproject；tool split 保留；PTY ensure/reuse；leaf session；D5 strip 拖拽；死 UnifiedTopBar 删除 |
| D2 | **partial → 更近 done** | 已：W4-8 metrics + empty-shell assert；**W5-3 silent complete alert**；**W5-5 / W7-1 health hook pack**（compact observe）；**W5-6 dev health overlay**。仍 residual：OTel / traceId e2e / 正式 health UI（若产品需要） |
| E0 | **partial** | **E0-1** 不变量 16 绿（`e0-invariants.md`）；**E0-2 / W7-4** typecheck 5 包 0 错（`e0-typecheck.md`）；**W7-2** 定向集成 **239** 绿（`wave5-6-integration.md`）；**W8-2** 扩展 smoke **413** 绿（`wave7-8-smoke.md`）；**E0-4 slice A / W9-MCP-1** I-DRAFT + hydrate sameRef **PASS**（`e0-mcp-journey.md`）；**W9-MCP-2** Stop aria **PASS**（store probe；`e0-mcp-stop-shell.md`）；**W9-MCP hydrate fork fix done**；**W9-DATA** SQLite/LS wipe **FIXED**（`session-body-empty-gap.md`）；**E0-5 / W10 multi-unit PASS**（open-split fix）。**W10 send**：原 SKIP（daemon `clientMessageId`）；**HOTFIX-1** validator **done** — **待 daemon 重启 re-verify**（未宣称 live send PASS）。**仍 open**：live send re-verify、live stream Stop、全量 `check:desktop`。**W6-4 / W6-5 已 done** |

## 最新验证

| 日期 | 范围 | 结果 |
|------|------|------|
| 2026-07-28 | shared-types + runtime control/loop + desktop draft/shell/pty/projection/persist/runControl | 通过（实施过程中 200+ 测） |
| 2026-07-29 | Wave 4 分项：tool.pre/post 52；session 99；binary-tree 30；PTY TS 29 + cargo pty；restore 55 | 分项通过（见波次记录） |
| 2026-07-29 | **W5-8** Wave 4 ownership 定向 vitest（agent-runtime + crish-desktop） | **302 测 PASS**（见 `wave4-smoke-results.md`） |
| 2026-07-29 | **W6-3** E0-1 gate invariants（I-DRAFT / I-PROJ / I-SHELL / I-PTY + message upsert） | **16 测 PASS**（见 `e0-invariants.md`） |
| 2026-07-29 | **E0-2 / W7-4** typecheck desktop + core（5 packages） | **0 errors PASS**（见 `e0-typecheck.md`） |
| 2026-07-29 | **W7-2** Wave 5+6 定向集成 vitest | **239 测 PASS**（见 `wave5-6-integration.md`） |
| 2026-07-29 | **W8-2** Wave 7–8 扩展定向 smoke | **413 测 PASS**（见 `wave7-8-smoke.md`：runtime 115 + desktop 268 + daemon 16 + shared-types 14） |
| 2026-07-29 | **W8-1** enqueueSteer soft default | **done** — soft/steer 公共路径；enqueueSteer = soft 安全点默认 |
| 2026-07-29 | **W8-3** send-while-running → follow_up soft | **done** — busy 发送走 follow_up / L1 soft，不 abort |
| 2026-07-29 | **E0-4 / W7-9** tauri-mcp 用户旅程（draft smoke） | **partial PASS**：I-DRAFT 新对话 / empty UI；**未**验 live send/stop/tool/重启（见 `e0-mcp-journey.md`） |
| 2026-07-29 | **E0-4 / W9-MCP-1** I-DRAFT 新对话 live re-verify | **PASS** slice A：19→19 无空壳、draft 不进 `sessions[]`、连点稳定、empty UI、历史会话 hydrate 14 msgs `sameRef=true`（见 `e0-mcp-journey.md`）；full send/stop 仍 pending |
| 2026-07-29 | **W9-MCP-2** Stop control + multi-unit readiness | **Stop aria PASS**（store probe）；当时 multi-unit **NOT EXERCISED** → 后由 **W10 multi-unit PASS**（open-split）关闭；live model Stop **SKIPPED**（`e0-mcp-stop-shell.md`） |
| 2026-07-29 | **W9-B3** sidebar compositionRoot | **done** — 侧栏「新对话」经 compositionRoot / shell.openNewDraftTab（或 session.enterDraft） |
| 2026-07-29 | **W9-DATA** session body empty / SQLite·LS wipe | **FIXED** — boot 空 LS 时从 SQLite fill；persist 拒空 body 覆盖（见 `session-body-empty-gap.md`） |
| 2026-07-29 | **W10-INT** post W8/W9 residual vitest | **197 core / 212 w/ sidebar PASS**（`wave10-integration.md`） |
| 2026-07-29 | **W10-MCP-1** full send journey | **SKIP → schema fixed** — 原 daemon reject `clientMessageId`；**HOTFIX-1** validator **done**；**待 daemon 重启 re-verify**（`e0-mcp-send.md`） |
| 2026-07-29 | **W10 multi-unit**（E0-5） | **PASS** — open-split fix 后 multi-unit 旅程通过 |
| 2026-07-29 | **W9-MCP** hydrate fork write | **FIXED** — activate hydrate dual-view fork write fix |
| 2026-07-29 | **OPT-8** optimization board + ledger 主线切换 | **done** — 测试暂停 primary；OPT 升 primary（`optimization-wave-board.md`） |
| 2026-07-29 | **OPT-1…OPT-9 + HOTFIX-1** optimization wave land | **done** — 见下表 OPT-A；board 波末回写 |
| 2026-07-29 | **OPT-B1…B7** product path / dedup land | **done** — import 31 tests、draft-only、CSS Diff/Approval/ToolCall、nav-keys root、AsyncMarkdown InlineAgent、sendTerminateDualWire flag、system-map-clear |
| 2026-07-29 | **OPT-C1…C8** optimization residual / docs land | **done** — 见下表 OPT-C；board / inventory / ledger 波末回写 |
| 2026-07-29 | **OPT-C1** layout ownership docs (#2) | **done（partial）** — storeOwnership + package headers + composition docs；call-site enforce residual |
| 2026-07-29 | **OPT-C2** empty-shell vs PENDING_DRAFT (#9) | **done** — single mental model in sessionTitle/emptyShellAssert + tests；inventory #9 marked |
| 2026-07-29 | **OPT-C3** transport daemon primary + flag (#10) | **done（partial）** — `streamViaDaemon` SoT；`ALLOW_AUTO_DIRECT_FETCH_FALLBACK`；cancel parity；flag 仍 true |
| 2026-07-29 | **OPT-C4** CSS tokens shell/models/panels | **done** — `style-token-unification.md` §9 |
| 2026-07-29 | **OPT-C5** import soft-dedup importMeta | **done** — `source + sourceSessionId`；skip default / reimport opt-in |
| 2026-07-29 | **OPT-C6** streamStop shared helper | **done** — `api/streamStop`；chat + agent L2/L3 wire |
| 2026-07-29 | **OPT-C7** docs refresh | **done** — map / inventory / board / ledger 同步 C 事实 |
| 2026-07-29 | **OPT-C8** FirstRunWizard test fix | **done** — 向导单测修复 |
| 2026-07-29 | **OPT-D** full-prompt batch（D1…D8） | **complete / landed** — short-prompt aborted（历史）；见下表 OPT-D |
| 2026-07-29 | **OPT-D1** providerProfiles / FirstRunWizard seed tests | **done** — 与当前配置轨对齐 |
| 2026-07-29 | **OPT-D2** BinaryTree / tab-drag CSS tokens | **done** — `style-token-unification.md` §11 |
| 2026-07-29 | **OPT-D3** compositionRoot.tree facade | **done** — getState + setLeafSessionId；hydrate 用 root.tree |
| 2026-07-29 | **OPT-D4** Tooltip single SoT | **done** — `components/Tooltip/` |
| 2026-07-29 | **OPT-D5** settings-plugins/advanced/usage/extensions tokens | **done** — `style-token-unification.md` §10 |
| 2026-07-29 | **OPT-D6** import custom roots | **done** — `api/import/importRootSettings.ts` + ExternalSessionImport UX |
| 2026-07-29 | **OPT-D7** docs pass | **done** — closeout supersede 早期派发表 |
| 2026-07-29 | **OPT-D8** chat pin path subscription perf | **done** — ChatMessageList `allMessages` prop（parent 传 messages） |
| 2026-07-29 | **OPT-E** full batch（E1…E9） | **complete / landed** — 见下表 OPT-E |
| 2026-07-29 | **OPT-E1** docs close OPT-D + open OPT-E | **done** — board / ledger / inventory 三件一致 |
| 2026-07-29 | **OPT-E2** chat CSS residual hex strip | **done** — ~29→0；`style-token-unification.md` §12 |
| 2026-07-29 | **OPT-E3** provider/accounts/toast/error/overview hex | **done** — ~46→0；§13 |
| 2026-07-29 | **OPT-E4** SettingsUI/sidebar/MCP/models/skills hex | **done** — ~36→0；§14 |
| 2026-07-29 | **OPT-E5** layout.setAppSettings + AppBootstrap | **done** — compositionRoot expand；23 tests |
| 2026-07-29 | **OPT-E6** sidebar command paths → compositionRoot | **done** — 15 sidebar tests |
| 2026-07-29 | **OPT-E7** openAgentPanel + workspaceChromeHooks → root | **done** — openAgentPanel 45 tests |
| 2026-07-29 | **OPT-E8** docs purge session-actions | **done** — kill #8；note `opt-e8-session-actions-docs-purge.md` |
| 2026-07-29 | **OPT-E9** ownershipEnforce + compositionRoot tests | **done** — 11 new + 17 = **28 pass**；kill #2 推进 |
| 2026-07-29 | **OPT-F** full batch（F1…F8） | **complete / landed** — 见下表 OPT-F |
| 2026-07-29 | **OPT-F1** docs close OPT-E + open OPT-F | **done** — board / ledger / inventory 三件一致 |
| 2026-07-29 | **OPT-F2** CSS residual A ModelDetail/Auth/UserView/Workspace/SettingsUsage | **done** — ~23→0；`style-token-unification.md` §15 |
| 2026-07-29 | **OPT-F3** CSS residual B chat-markdown/ProjectPicker/dock/menus/cards/pickers | **done** — ~20→0；§16 |
| 2026-07-29 | **OPT-F4** useStreamCallbacks → compositionRoot layout/session | **done** — 14 chat-stream tests；layout.setState residual intentional |
| 2026-07-29 | **OPT-F5** useToolDockTabDrag + useTopBarDrag → compositionRoot | **done** — 86 drag-related tests |
| 2026-07-29 | **OPT-F6** useTreeResize + useChatHandlers → compositionRoot | **done** — 42 tests |
| 2026-07-29 | **OPT-F7** transport degraded metric + one-shot console | **done** — kill #10 residual metric；flag stay true |
| 2026-07-29 | **OPT-F8** system-map + inventory + composition docs refresh | **done** — OPT-F facts 回写 |
| 2026-07-29 | **OPT-G** full batch（G1…G8） | **complete / landed** — 见下表 OPT-G |
| 2026-07-29 | **OPT-G1** docs close OPT-F + open OPT-G | **done** — board / ledger / inventory 三件一致 |
| 2026-07-29 | **OPT-G2** CSS final tiny residual | **done** — ~15→0；FirstRunWizard residual deferred → H2 |
| 2026-07-29 | **OPT-G3** useAgentStream + useSlashSend → root | **done** — new useSlashSend tests；stop/stream keep |
| 2026-07-29 | **OPT-G4** openTool + layoutRestorePolicy + treePanelAccess → root | **done** — same-store skip；cold-start tree via root；292 shell/tree tests |
| 2026-07-29 | **OPT-G5** ChatHeader + useChatPanelSync + useGoalMode → root | **done** — kill #6 推进 |
| 2026-07-29 | **OPT-G6** SessionSyncService + workspaceLayoutStore → root | **done** — kill #6 推进 |
| 2026-07-29 | **OPT-G7** SessionFacade pin/unpin/archive/unarchive/branch | **done** — sidebar menu wire；44 tests |
| 2026-07-29 | **OPT-G8** Dead dual-path scan delete | **done** — git/ unused api components；SettingsUI Tooltip re-export removed |
| 2026-07-29 | **OPT-G post-hotfix** | **done** — useChatHandlers arity；hydrate immer；message-identity；parseCodex；`tsc -b desktop` 0 err |
| 2026-07-29 | **OPT-H** full batch（H1…H8） | **complete / landed** — 见下表 OPT-H |
| 2026-07-29 | **OPT-H1** docs close OPT-G + open OPT-H | **done** — board / ledger / inventory 三件一致 |
| 2026-07-29 | **OPT-H2** FirstRunWizard.module.css residual hex | **done** — hex → 0 |
| 2026-07-29 | **OPT-H3** TSX inline hex residual high-traffic | **done** — ~52→0；Terminal xterm ANSI residual |
| 2026-07-29 | **OPT-H4** document stream setState residual（choice B） | **done** — `opt-h4-layout-setstate-residual.md`；no patchState / no god rewrite |
| 2026-07-29 | **OPT-H5** mcpBridge → compositionRoot | **done** — kill #6 residual slice |
| 2026-07-29 | **OPT-H6** inventory/board kill-list refresh after G | **done** — G3–G7 **done**（corrected from mislabel in flight） |
| 2026-07-29 | **OPT-H7** FirstRunWizard + import residual polish | **done** — import/wizard **66 tests**；hasCustomImportRoot UX |
| 2026-07-29 | **OPT-H8** system-map pin/archive facade docs | **done** — compositionRoot pin/archive methods |

## 已关闭（Wave 4 residual）

| # | 项 | 关闭于 |
|---|-----|--------|
| — | tool.pre/post 全链路 wire 进 session-loop + ToolExecutor | W4-1 |
| — | session-actions/ 死树物理删除 | W4-2 |
| — | strip 窄订阅 + sash memo | W4-3 |
| — | PTY exit `kill_all`（Rust Exit + FE composition 路径） | W4-4 |
| — | multi-unit layout restore ADR + `ui.restoreLastWorkspace` 默认 false | W4-5 |
| — | ModelView/UserView debug 面板（Settings profile） | W4-6 |
| — | D0 死 TS md 路径 purge | W4-7 |
| — | D2 metrics 扩展 + empty-shell assert | W4-8 |

## 已关闭（Wave 5 Integration / residual）

| # | 项 | 关闭于 |
|---|-----|--------|
| W5-1 | tool stream lite store（`streamingStore` tools 路径） | W5-1 |
| W5-2 | B3 compositionRoot 扩展 runControl / metrics / session | W5-2 |
| W5-3 | silent complete alert | W5-3 |
| W5-4 | 死代码删除（usePreloader 等） | W5-4 |
| W5-5 | health hook pack | W5-5 |
| W5-6 | dev health overlay | W5-6 |
| W5-7 | 文档同步 | W5-7 |
| W5-8 | 定向 smoke / 回归 **302** 测通过 | W5-8 |

## 已关闭（Wave 6 Runtime / shell / E0）

| # | 项 | 关闭于 | 备注 |
|---|-----|--------|------|
| W6-1 | force / steer / followUp pi queue | W6-1 | done |
| W6-2 | PTY 自有 Job Object（Windows） | W6-2 | 与 shell S4.6 对齐；exit kill_all 已 W4-4 |
| W6-3 | E0 不变量套件 | W6-3 | 16 测 PASS |
| W6-4 | continue after abort | W6-4 | **done**（runtime loop + EventRouter.terminal + SessionStreamManager stop 测） |
| W6-5 | daemon 测试 | W6-5 | **done**（含 run-control 测；W8-2 切片 daemon 16 PASS） |
| W6-6 | message id 幂等 | W6-6 | done |
| W6-7 | shell a11y（strip roving）+ toolColumn lock | W6-7 | done；live resize DOM map 部分（见 shell plan S4.3） |
| W6-8 | context.compact lifecycle | W6-8 | done |

## 已关闭（Wave 7 Harden / hydrate / stop UX / gates）

| # | 项 | 关闭于 | 备注 |
|---|-----|--------|------|
| W7-1 | health pack compact observe | W7-1 | D2 health pack 加固；compact 观测接线 |
| W7-2 | Wave 5+6 定向集成 vitest | W7-2 | **239 测 PASS**（`wave5-6-integration.md`） |
| W7-3 | 本 ledger 同步 | W7-3 | 进度真源维护 |
| W7-4 | E0-2 typecheck 5 packages | W7-4 | **0 errors**（`e0-typecheck.md`） |
| W7-5 | Stop L2 / L3 UI labels + tests | W7-5 | Composer / useAgentStream stop 测等 |
| W7-6 | clientMessageId 端到端 stream 接线 | W7-6 | C0 发送/流路径加固 |
| W7-7 | perf-report 文档 | W7-7 | `wave4-6-perf-notes.md` + MULTI_AGENT_PERF_PLAN §12 |
| W7-8 | AgentCard / inlineAgentPanel `onForceStop` L3 | W7-8 | Force=L3 与 Stop=L2 对齐 B1 |
| W7-9 | e0-mcp-journey draft | W7-9 | **partial**（I-DRAFT + empty UI；full model 旅程未跑） |
| W7-10 | empty messages：lazy OK + `getSessionForWrite` immer fork fix | W7-10 | sessionIndex rebind；activate lazy hydrate 测 |

## 已关闭（Wave 8 Queue / expanded smoke）

| # | 项 | 关闭于 | 备注 |
|---|-----|--------|------|
| W8-1 | enqueueSteer soft default | W8-1 | **done** — soft/steer 公共路径；enqueueSteer = soft 安全点 |
| W8-2 | 扩展定向 smoke | W8-2 | **413 测 PASS**（`wave7-8-smoke.md`） |
| W8-3 | send-while-running → follow_up soft | W8-3 | **done** — busy 发送 L1 follow_up / soft，不 abort 当前 run |

## Wave 9（partial — 多切片已落地）

| # | 项 | 状态 | 备注 |
|---|-----|------|------|
| W9-MCP-1 | E0-4 slice A I-DRAFT + hydrate sameRef | **done / PASS** | live re-verify 见 `e0-mcp-journey.md`；full send 待 daemon 重启 re-verify |
| W9-MCP-2 | Stop aria + multi-unit readiness | **partial → multi-unit 见 W10 PASS** | Stop aria **PASS**（store probe）；live model Stop **SKIPPED** |
| W9-MCP hydrate | activate hydrate fork write | **FIXED** | dual-view fork write fix |
| W9-B3 | sidebar compositionRoot | **done** | 侧栏「新对话」经 compositionRoot；B3 更近 done |
| W9-DATA | SQLite / LS wipe bug | **FIXED** | 见 `session-body-empty-gap.md`；boot fill + 拒空 body 覆盖 |
| W9-* 其余 | full send / live stop | **→ Wave 10 residual** | E0 仍 **partial** 直至 live send re-verify + live stream Stop |

## Wave 10（paused as primary — residual 索引）

| # | 项 | 状态 | 备注 |
|---|-----|------|------|
| W10-1 | MCP full send journey（live model） | **SKIP → HOTFIX-1 done；re-verify pending** | 原 daemon reject `clientMessageId`；validator 已修；**需 daemon 重启后 re-verify**（`e0-mcp-send.md`）；**勿**标 live send PASS |
| W10-2 | Multi-unit split MCP（E0-5） | **PASS** | open-split fix 后 multi-unit **PASS** |
| W10-3 / strip B3 | B3 residual：strip composition | **residual** | sidebar W9-B3；**OPT-5** layout facade / **OPT-9** cancel 已推进 compositionRoot |
| W10-4 | D0 md fixture parity | **residual / partial land** | 见 `d0-md-fixture-parity.md` |
| W10-5 | Soft inject productization | **n/a** | W8-1/W8-3 已 done |
| W10-6 | Integration fix | **partial → 更好** | W10-INT **197 PASS**；send schema **HOTFIX-1 done**（runtime re-verify 仍 pending） |
| W10-7 | Docs close-out | **done via OPT-8** | 优化主线文档 + 波末回写 |
| W10-8 | Optional strip a11y residual | optional | 非优化主线硬门 |
| **HOTFIX-1** | run-task `clientMessageId` validator | **done** | 解锁 send schema；daemon 重启后验 live send |

历史派发板：`wave9-10-dispatch-board.md`。
**当前派发板：** [`optimization-wave-board.md`](./optimization-wave-board.md)。

## Optimization wave（**primary** 2026-07-29）

### OPT-A（landed）

| # | 项 | 状态 | 备注 |
|---|-----|------|------|
| OPT-1 | 外部导入 parsers + ADR | **done** | 初版 26 tests；**B1 → 31** |
| OPT-2 | 外部导入 Settings + FirstRunWizard 点击 UX | **done** | 共享导入实现；点击流 |
| OPT-3 | 功能去重 inventory **top 10** | **done** | 见 `architecture-dedup-inventory.md`（B 已回写 kill） |
| OPT-4 | CSS tokens（top bar / settings / empty） | **done** | 壳层 + 设置 + empty；**B3** 续 Diff/Approval/ToolCall |
| OPT-5 | compositionRoot **layout facade** | **done** | layout 组装 facade |
| OPT-6 | 大块死代码删除 dual composer / dual settings | **done** | 双实现收口 |
| OPT-7 | stream dual-sub **4→2** | **done** | 流订阅收窄；perf ROI（S4.4 近 done） |
| OPT-8 | 文档收口（board + ledger） | **done** | 主线切换 + 波末结果 |
| OPT-9 | cancel 经 compositionRoot + useAgentPanel | **done** | Stop/cancel 路径收口；控制面 keep |
| HOTFIX-1 | run-task `clientMessageId` validator | **done** | send schema；live re-verify 待 daemon 重启 |

### OPT-B（**complete**）

| # | 项 | 状态 | 备注 |
|---|-----|------|------|
| OPT-B1 | Import **real Tauri FS** + **31 tests** | **done** | `api/import/**`；产品 FS 非 agent 扫盘 |
| OPT-B2 | Session create **draft only** | **done** | `createSessionAndOpenChat` deprecated；kill #1 |
| OPT-B3 | CSS Diff / Approval / ToolCall tokens | **done** | `style-token-unification.md` §8 |
| OPT-B4 | navigation-keys → compositionRoot.layout | **done** | kill #6 partial |
| OPT-B5 | system-map-clear 人类一页地图 | **done** | `docs/architecture/system-map-clear.md` |
| OPT-B6 | InlineAgentPanel → AsyncMarkdownBlock | **done** | kill #5 product |
| OPT-B7 | `sendTerminateDualWire` + dual-wire flag | **done（helper）** | kill #3 partial / #4 flagged；删 dual gated E0 |

### OPT-C（**complete**）

| # | 项 | 状态 | 备注 |
|---|-----|------|------|
| OPT-C1 | Layout identity ownership docs (#2) | **done（partial）** | `storeOwnership` + store README + composition docs；call-site residual |
| OPT-C2 | Empty-shell vs PENDING_DRAFT mental model (#9) | **done** | sessionTitle / emptyShellAssert / ADR；tests I-DRAFT+GC |
| OPT-C3 | Transport daemon primary + `ALLOW_AUTO_DIRECT_FETCH_FALLBACK` (#10) | **done（partial）** | daemon WS SoT；direct fetch degraded；flag default true |
| OPT-C4 | CSS tokens shell / models / panels | **done** | `style-token-unification.md` §9 |
| OPT-C5 | Import soft-dedup via `importMeta` | **done** | `source + sourceSessionId`；skip / reimport |
| OPT-C6 | `streamStop` shared helper | **done** | `api/streamStop`；chat + agent L2/L3 wire |
| OPT-C7 | Docs refresh | **done** | map / inventory / board / ledger |
| OPT-C8 | FirstRunWizard test fix | **done** | 向导单测修复 |

### OPT-D（**complete / landed**）

| # | 项 | 状态 | 备注 |
|---|-----|------|------|
| OPT-D1 | providerProfiles / FirstRunWizard seed tests align | **done** | 与当前配置轨对齐 |
| OPT-D2 | BinaryTree / tab-drag CSS tokens | **done** | `style-token-unification.md` §11 |
| OPT-D3 | compositionRoot.tree facade | **done** | getState + setLeafSessionId；hydrate 用 root.tree；kill #6 推进 |
| OPT-D4 | Tooltip single SoT | **done** | `components/Tooltip/` |
| OPT-D5 | settings-plugins / advanced / usage / extensions tokens | **done** | `style-token-unification.md` §10 |
| OPT-D6 | import custom roots | **done** | `api/import/importRootSettings.ts` + ExternalSessionImport UX |
| OPT-D7 | Docs pass | **done** | closeout supersede 早期派发表 |
| OPT-D8 | chat pin path subscription perf | **done** | ChatMessageList `allMessages` prop |

### OPT-E（**complete / landed**）

| # | 项 | 状态 | 备注 |
|---|-----|------|------|
| OPT-E1 | Docs close OPT-D + open OPT-E | **done** | board / ledger / inventory |
| OPT-E2 | CSS tokens: ChatStatusRibbons + ChatComposer + ChatMessageRow residual hex | **done** | ~29→0；§12 |
| OPT-E3 | CSS tokens: provider/accounts/toast/error/overview residual hex | **done** | ~46→0；§13 |
| OPT-E4 | CSS tokens: SettingsUI + SidebarSessionList + McpSettingsTab residual | **done** | ~36→0；§14 |
| OPT-E5 | layout facade setAppSettings + compositionRoot expand；AppBootstrap optional fallback | **done** | kill #6；23 tests |
| OPT-E6 | sidebar command paths → compositionRoot | **done** | kill #6；15 sidebar tests |
| OPT-E7 | openAgentPanel + workspaceChromeHooks → compositionRoot | **done** | kill #6；openAgentPanel 45 tests |
| OPT-E8 | Docs purge kill #8：stale session-actions/ paths | **done** | kill **#8 done**；note `opt-e8-session-actions-docs-purge.md` |
| OPT-E9 | Layout ownership call-site enforce tests（kill #2 residual） | **done** | ownershipEnforce 11 + compositionRoot 17 = **28 pass** |

### OPT-F（**complete / landed**）

| # | 项 | 状态 | 备注 |
|---|-----|------|------|
| OPT-F1 | Docs close OPT-E + open OPT-F | **done** | board / ledger / inventory |
| OPT-F2 | CSS residual A: ModelDetailPanel + AuthConfigSection + UserViewDebugPanel + Workspace.module + SettingsUsage | **done** | ~23→0；§15 |
| OPT-F3 | CSS residual B: chat-markdown + ProjectPicker + RightToolDockHeader + SidebarContextMenus + OverviewCard + ModelPicker + ChatHeader | **done** | ~20→0；§16 |
| OPT-F4 | useStreamCallbacks → compositionRoot layout/session | **done** | kill #6 推进；14 chat-stream tests；layout.setState residual intentional |
| OPT-F5 | useToolDockTabDrag + useTopBarDrag → compositionRoot | **done** | kill #6 推进；86 drag-related tests |
| OPT-F6 | useTreeResize + useChatHandlers → compositionRoot | **done** | kill #6 推进；42 tests |
| OPT-F7 | Transport degraded path: metric + one-shot console（keep flag true） | **done** | kill #10 residual metric **done**；flag flip residual |
| OPT-F8 | system-map + inventory + composition docs refresh | **done** | OPT-F facts |

### OPT-G（**complete / landed**）

| # | 项 | 状态 | 备注 |
|---|-----|------|------|
| OPT-G1 | Docs close OPT-F + open OPT-G | **done** | board / ledger / inventory |
| OPT-G2 | CSS final tiny residual: TerminalCard + InlineAgentPanel + QuickOpen + ScheduledTasks + chat.css + settings-models residual | **done** | ~15→0；FirstRunWizard residual deferred → H2 |
| OPT-G3 | useAgentStream + useSlashSend → compositionRoot | **done** | new useSlashSend tests；stop/stream keep |
| OPT-G4 | openTool + layoutRestorePolicy + treePanelAccess command paths → root | **done** | same-store skip；cold-start tree via root；292 shell/tree tests |
| OPT-G5 | ChatHeader.tsx + useChatPanelSync + useGoalMode → root | **done** | kill #6 推进 |
| OPT-G6 | SessionSyncService + workspaceLayoutStore residual → root | **done** | kill #6 推进 |
| OPT-G7 | Expand session/layout facade: pin / archive / branch（clear sidebar TODO） | **done** | SessionFacade pin/unpin/archive/unarchive/branch；sidebar menu wire；44 tests |
| OPT-G8 | Dead code / unused dual-path scan delete（narrow, safe） | **done** | git/ unused api components；SettingsUI Tooltip re-export removed |
| post-G hotfix | useChatHandlers arity / hydrate immer / message-identity / parseCodex | **done** | `tsc -b desktop` 0 errors |

### OPT-H（**complete / landed**）

| # | 项 | 状态 | 备注 |
|---|-----|------|------|
| OPT-H1 | Docs close OPT-G + open OPT-H | **done** | board / ledger / inventory |
| OPT-H2 | FirstRunWizard.module.css residual hex | **done** | hex → **0**（G2 deferred closed） |
| OPT-H3 | TSX inline hex residual high-traffic（AgentTeamBoard、ModelConfigEditor 等）→ tokens | **done** | ~52→**0**；Terminal **xterm ANSI** residual |
| OPT-H4 | Document stream setState residual（choice B；**no patchState / no god rewrite**） | **done** | note `opt-h4-layout-setstate-residual.md`；intentional residual |
| OPT-H5 | mcpBridge / remaining command getState → compositionRoot | **done** | kill #6 residual slice landed |
| OPT-H6 | Inventory/board kill-list refresh after G | **done** | G3–G7 **done**（H6 误标 in flight → corrected） |
| OPT-H7 | FirstRunWizard + import residual polish tests | **done** | import/wizard **66 tests**；`hasCustomImportRoot` UX |
| OPT-H8 | system-map compositionRoot pin/archive methods | **done** | pin/archive facade docs |

**派发注记：** short-prompt OPT-D 再派发曾 **aborted**（历史）；OPT-D/E/F/G/H full-prompt **complete**；**OPT-A…OPT-H complete**。
详表与验收：`optimization-wave-board.md`（含初版 ID→落地映射 + OPT-B/C/D/E/F/G/H）。
**Residual after H：** dual cancel **gated** E0 live Stop；transport flag **still true**（flip residual）；stream setState **intentional**；Terminal xterm ANSI；E0 **partial** — **no** live send PASS.

## 未做完 / 后续可迭代

1. 进程外 Hook（jcode 式外部命令）— 明确非本中控主路径
2. PTY 进程树 — **exit kill_all done (W4-4)**；**PTY Job Object Windows done (W6-2)**。跨平台/残余孤儿策略若需再迭代可挂 shell plan
3. E0 仍 **partial**（**测试非 primary**）：不变量 16 + typecheck + 定向 239 + 扩展 413 已绿；I-DRAFT+hydrate **PASS**；Stop aria **PASS**；multi-unit **PASS**；W10 send schema **HOTFIX-1 done** — **仍待** daemon 重启后 live send re-verify、live stream Stop、全量 `check:desktop` — **统一测试后置**
4. B3：**更近 done** — W5-2 + **W9-B3 sidebar** + **OPT-5 layout facade** + **OPT-9 cancel** + **OPT-B4 navigation-keys** + **OPT-D3 tree facade** + **OPT-E5 setAppSettings** + **OPT-E6 sidebar** + **OPT-E7 openAgentPanel** + **OPT-F4–F6 done**（stream/drag/tree/chatHandlers）+ **OPT-G3–G7 done**（agent/slash/tool/header/session/pin-archive-branch）+ **OPT-H5 mcpBridge done**；stream setState residual **intentional documented**（**OPT-H4**）；leftover strip may remain
5. D0 residual：fixture / stream crate（tool lite / strip·sash / dead md / perf-report / OPT-7 dual-sub / **OPT-B6 product MD SoT** 已关）
6. D2 residual：OTel / traceId e2e / 正式 health UI
7. Wave 8：**全量 done**（W8-1 / W8-2 **413** / W8-3）
8. Wave 9：**partial** 已归档（MCP-1 PASS、MCP-2 stop PASS、hydrate fork fixed、B3 sidebar、DATA fixed；multi-unit 见 W10 PASS）
9. Wave 10：**paused as primary** — multi-unit **PASS**；send re-verify pending（HOTFIX-1）；不阻塞 OPT
10. **Optimization primary**：OPT-A **landed**；**OPT-B/C/D/E/F/G/H complete**；E0 后置
11. Shell residual（可挂 shell plan）：live resize 子树 paint（S4.3）；**S4.4** stream 双订 **OPT-7 done（4→2）**；pin 路径 **OPT-D8 done**（`allMessages` prop）；list 侧 dual-sub 若仍有则另挂
12. Dedup post-H：kill #1/#5/#8/#9 product **done**；#2 partial（**E9** enforce tests landed）；#10 partial（**F7 metric done**；**flag flip residual**；flag **still true**）；#3 partial（+C6 streamStop）/ #4 flagged（dual cancel **gated** E0 live Stop）/ #6 near-done（**D3 + E5–E7 + F4–F6 + G3–G7 done** + **H5 mcpBridge done**；**H4 setState intentional residual** + any leftover strip）；import soft-dedup **C5 done**；import custom roots **D6 done**；Terminal xterm ANSI residual


## 波次记录

| Wave | Status | Agents | 成果 |
|------|--------|--------|------|
| 1 Foundation | **done** | 5 | 契约、draft、control+hooks、消息幂等、shell/PTY |
| 2 Wire+Cleanup | **done** | 4 | UI stop、投影渲染、D5+删死代码、types 对齐文档 |
| 3 Close loop | **done** | 2 | daemon L2/L3、persist+metrics |
| 4 Residual close | **done** (2026-07-29) | 8 | W4-1 tool.pre/post；W4-2 删 session-actions；W4-3 strip/sash；W4-4 PTY exit kill_all；W4-5 restore ADR；W4-6 ModelView debug；W4-7 D0 dead md；W4-8 D2 metrics/empty-shell |
| 5 Integration / residual | **done** (2026-07-29) | 8 | W5-1 tool lite store；W5-2 compositionRoot runControl/metrics/session；W5-3 silent complete；W5-4 死代码；W5-5 health pack；W5-6 dev overlay；W5-7 docs；W5-8 smoke **302** PASS |
| 6 Runtime / shell / E0 | **done** (2026-07-29) | 8 | W6-1 force/steer/followUp queue；W6-2 PTY Job Object；W6-3 E0 不变量 16；**W6-4 continue-after-abort**；**W6-5 daemon 测**；W6-6 message id 幂等；W6-7 a11y + toolColumn lock；W6-8 context.compact |
| 7 Harden / hydrate / stop / gates | **done** (2026-07-29) | 10 | W7-1 health compact observe；W7-2 集成 **239**；W7-3 ledger；W7-4 typecheck 0 err；W7-5 Stop L2/L3 labels；W7-6 clientMessageId stream；W7-7 perf-report；W7-8 onForceStop L3；W7-9 e0-mcp draft **partial**；W7-10 lazy empty + getSessionForWrite fix |
| 8 Queue / expanded smoke | **done** (2026-07-29) | — | **W8-1** enqueueSteer soft **done**；**W8-2 smoke 413 PASS**；**W8-3** send-while-running → follow_up soft **done** |
| 9 MCP / data / B3 sidebar | **partial** (2026-07-29) | MCP + data + B3 | **W9-MCP-1** I-DRAFT+hydrate **PASS**；**W9-MCP-2** Stop aria **PASS**；hydrate fork **FIXED**；**W9-B3** sidebar compositionRoot **done**；**W9-DATA** wipe **FIXED**；multi-unit → W10 **PASS** |
| 10 E0 close / residual | **paused as primary** (2026-07-29) | multi-unit PASS；send HOTFIX-1 + re-verify pending | 测试主线让位优化波；E0 仍 partial；见 `wave9-10-dispatch-board.md` + `e0-mcp-send.md` |
| **OPT-A** Architecture / dedup / styles / perf / external import | **landed** (2026-07-29) | OPT-1…OPT-9 + HOTFIX-1 **done** | 见 board；控制面 keep |
| **OPT-B** Path harden / kill-list land | **complete** (2026-07-29) | B1…B7 **done** | import 31、draft-only、CSS surfaces、nav-keys、AsyncMD panel、dual-wire helper、system-map |
| **OPT-C** Ownership / transport / tokens / import / stop / docs | **complete** (2026-07-29) | C1…C8 **done** | layout docs partial、empty-shell、daemon transport+flag、shell/models/panels tokens、importMeta soft-dedup、streamStop、docs、FirstRunWizard tests |
| **OPT-D** Tokens / facade / Tooltip / import roots / pin perf / docs | **complete** (2026-07-29) | D1–D8 **done** | providerProfiles tests、BinaryTree tokens、tree facade、Tooltip SoT、settings tokens、import custom roots、docs、pin `allMessages`；E0 send 仍待 daemon 重启 |
| **OPT-E** Tokens residual / compositionRoot expand / docs purge / layout enforce | **complete** (2026-07-29) | E1–E9 **done** | CSS §12–14；setAppSettings/sidebar/openAgentPanel → root；kill #8 docs purge；ownershipEnforce 28 pass |
| **OPT-F** CSS residual / compositionRoot migrate / transport metric / docs refresh | **complete** (2026-07-29) | F1–F8 **done** | CSS §15–16；stream/drag/tree/chatHandlers → root；F7 degraded metric（flag stay true）；system-map+inventory+composition docs |
| **OPT-G** CSS final tiny / compositionRoot expand / dead dual-path | **complete** (2026-07-29) | G1–G8 **done** + post-hotfix | CSS ~15→0；agent/slash/tool/header/session/pin-archive → root；dead dual-path delete；`tsc -b desktop` 0 err |
| **OPT-H** FirstRunWizard+TSX hex / setState docs / mcpBridge / kill-list / import tests / system-map | **complete** (2026-07-29) | H1–H8 **done** | H2 CSS hex→0；H3 TSX ~52→0；H4 setState residual documented；H5 mcpBridge→root；H6 G3–G7 **done**；H7 66 tests + hasCustomImportRoot；H8 pin/archive map |

## Wave 5–10 + OPT 收口摘要

- **D0 更近 done**：tool stream lite + strip/sash + md purge + **perf-report (D0-8 / W7-7)** + **OPT-7 stream dual-sub 4→2** + **OPT-B6 InlineAgentPanel AsyncMarkdownBlock** 已关；余 fixture（W10-4）/stream crate。
- **D2 更近 done**：health pack、compact observe（W7-1）、dev overlay、silent complete 已关；余 OTel/trace/正式 UI。
- **B3 更近 done**：W5-2 compositionRoot + **W9-B3 sidebar** + **OPT-5 layout facade** + **OPT-9 cancel** + **OPT-B4 navigation-keys** + **OPT-D3 tree facade** + **OPT-E5 setAppSettings** + **OPT-E6 sidebar** + **OPT-E7 openAgentPanel** + **OPT-F4–F6**（stream/drag/tree/chatHandlers）+ **OPT-G3–G7**（agent/slash/tool/header/session/pin-archive-branch）+ **OPT-H5 mcpBridge** 已关；stream setState residual **intentional**（**OPT-H4** documented）；leftover strip may remain。
- **E0 仍 partial**（测试非 primary）：不变量 16 + typecheck + 定向 239 + 扩展 413 绿；I-DRAFT + hydrate sameRef **PASS**；Stop aria **PASS**（probe）；**W9-DATA wipe FIXED**；hydrate fork **FIXED**；**W10 multi-unit PASS**；W10 send 原 SKIP → **HOTFIX-1 clientMessageId validator done** — **待 daemon 重启 re-verify**（未宣称 live send PASS）；live stream Stop / full `check:desktop` 仍 open — 统一测试后置。
- **W6-4 / W6-5**：**done**（不再作为尾巴）。
- **Wave 7**：**done**（含 hydrate lazy、stop UX、clientMessageId stream、gates）。
- **Wave 8**：**done** — W8-1 soft / W8-2 **413** / W8-3 follow_up soft。
- **Wave 9**：**partial** — MCP-1 PASS、MCP-2 stop PASS、hydrate fork fixed、B3 sidebar done、DATA fixed；multi-unit 见 W10。
- **Wave 10**：**paused as primary** — multi-unit **PASS**（open-split）；send **HOTFIX-1 done / re-verify pending**；W10-INT **197 PASS**。
- **OPT-A（primary landed）**：OPT-1…OPT-9 + HOTFIX-1 **done** — import parsers/ADR、Settings+Wizard UX、dedup top10、CSS tokens、compositionRoot layout facade、dead dual 删除、stream 4→2、cancel compositionRoot、docs。
- **OPT-B（complete）**：B1 real Tauri FS + **31 tests**；B2 draft-only / deprecated shim；B3 Diff/Approval/ToolCall tokens；B4 navigation-keys→root；B5 system-map-clear；B6 InlineAgentPanel AsyncMarkdownBlock；B7 sendTerminateDualWire + `TRANSITIONAL_DUAL_CANCEL_RUN_WIRE`。
- **OPT-C（complete）**：C1 layout ownership docs（#2 partial）；C2 empty-shell vs draft（#9 done）；C3 transport daemon primary + `ALLOW_AUTO_DIRECT_FETCH_FALLBACK`（#10 partial）；C4 shell/models/panels tokens；C5 import soft-dedup `importMeta`；C6 `api/streamStop` shared helper；C7 docs refresh；C8 FirstRunWizard test fix。
- **OPT-D（complete / landed）**：D1 providerProfiles/Wizard seed tests；D2 BinaryTree/tab-drag tokens；D3 `compositionRoot.tree`；D4 Tooltip SoT；D5 settings tokens；D6 import custom roots；D7 docs；D8 chat pin `allMessages` prop。
- **OPT-E（complete / landed）**：E1 docs；E2–E4 CSS residual §12–14；E5 setAppSettings + AppBootstrap；E6 sidebar → root；E7 openAgentPanel + workspaceChromeHooks；E8 docs purge kill #8；E9 ownershipEnforce 28 pass。
- **OPT-F（complete / landed）**：F1 docs；F2–F3 CSS residual §15–16；F4–F6 compositionRoot migrate（stream/drag/tree/chatHandlers）；F7 transport degraded metric + one-shot console（flag stay true）；F8 system-map + inventory + composition docs。
- **OPT-G（complete / landed）**：G1 docs；G2 CSS final residual ~15→0（FirstRunWizard deferred H2 → **H2 closed**）；G3–G7 compositionRoot expand（agent/slash/tool/header/session/pin-archive-branch）**done**；G8 dead dual-path delete；post-G hotfix `tsc -b desktop` 0 err。
- **OPT-H（complete / landed）**：H1 docs；H2 FirstRunWizard CSS hex→0；H3 TSX inline hex ~52→0 high-traffic；H4 stream setState residual **documented intentional**（no patchState）；H5 mcpBridge→compositionRoot；H6 kill-list refresh（G3–G7 **done** corrected）；H7 import/wizard **66 tests** + hasCustomImportRoot UX；H8 system-map pin/archive facade。
- **OPT residual after H：** dual cancel **gated** E0 live Stop；transport flag **still true**（flip residual）；Terminal xterm ANSI；stream setState intentional；E0 **partial** — **no** live send PASS。
- **PTY Job Object**：Windows 侧 **done (W6-2)**（配合 W4-4 exit kill_all）。
- **文档**：本 ledger 为进度真源；master plan §21 仅脚注指向本文件；**当前派发板** `optimization-wave-board.md`；人类地图 `system-map-clear.md`；测试波历史板 `wave9-10-dispatch-board.md`。
