# Architecture Dedup Inventory (feature 去重)

| Field | Value |
|-------|-------|
| Agent | Explorer OPT-3 → **OPT-B…H kill progress** · **OPT-H complete**（H1–H8 landed；#6 G3–G7 **done** + H5 mcpBridge **done**；H4 setState intentional residual；#10 F7 done flag flip residual；E9 ownership #2；E8 #8） |
| Date | 2026-07-29 |
| Scope | Dual / dual-path inventory that confuses control planes (no product code) |
| Ledger | [`system-control-ledger.md`](./system-control-ledger.md) |
| Board | [`optimization-wave-board.md`](./optimization-wave-board.md) |
| Master | [`docs/plans/2026-07-system-architecture-control-master-plan.md`](../2026-07-system-architecture-control-master-plan.md) |
| System map | [`docs/architecture/system-map-clear.md`](../../architecture/system-map-clear.md) |

**Rule for this doc:** Top **10** P0/P1 only. Concrete paths. Prefer merge/delete of *paths*, not new features. **Do not invent E0 PASS** (live send still pending daemon re-verify).

### OPT-B land map（2026-07-29）

| OPT-B | Landed | Kill / surface |
|-------|--------|----------------|
| **B1** | Import **real Tauri FS** + parsers detect/map | product `api/import/**`；**31 unit tests** |
| **B2** | Session create **draft only** | kill **#1 done**；`createSessionAndOpenChat` @deprecated |
| **B3** | CSS tokens Diff / Approval / ToolCall | style residual；见 `style-token-unification.md` §8 |
| **B4** | `navigation-keys` → compositionRoot.layout | kill **#6 partial**（shortcuts layout） |
| **B5** | `system-map-clear.md` 人类一页地图 | 架构导航真源（OPT-C7 刷新本波事实） |
| **B6** | InlineAgentPanel → `AsyncMarkdownBlock` | kill **#5 done**（completed path） |
| **B7** | `sendTerminateDualWire` + `TRANSITIONAL_DUAL_CANCEL_RUN_WIRE` | kill **#3 partial / #4 flagged** |

### OPT-E land map（2026-07-29）

| OPT-E | Landed | Kill / surface |
|-------|--------|----------------|
| **E2–E4** | CSS residual chat/provider/settings hex strip | style §12–14；~111 hex → 0 on owned surfaces |
| **E5** | `layout.setAppSettings` + AppBootstrap optional fallback | kill **#6** progress；23 tests |
| **E6** | sidebar command paths → compositionRoot | kill **#6** progress；15 sidebar tests |
| **E7** | openAgentPanel + workspaceChromeHooks → root | kill **#6** progress；openAgentPanel 45 tests |
| **E8** | Docs purge stale `session-actions/` paths | kill **#8 done**；note `opt-e8-session-actions-docs-purge.md` |
| **E9** | ownershipEnforce + compositionRoot tests | kill **#2** progress；11 + 17 = **28 pass** |

### OPT-F land map（2026-07-29）

| OPT-F | Landed | Kill / surface |
|-------|--------|----------------|
| **F2–F3** | CSS residual ModelDetail/Auth/UserView/Workspace + chat-markdown/dock/menus/pickers | style §15–16；~43 hex → 0 on owned surfaces |
| **F4** | useStreamCallbacks → compositionRoot layout/session | kill **#6** progress；14 chat-stream tests |
| **F5** | useToolDockTabDrag + useTopBarDrag → root | kill **#6** progress；86 drag-related tests |
| **F6** | useTreeResize + useChatHandlers → root | kill **#6** progress；42 tests |
| **F7** | transport degraded metric + one-shot console | kill **#10** residual metric **done**；flag stays true |
| **F8** | system-map + inventory + composition docs | docs |

### OPT-G land map（2026-07-29 — **complete / landed**）

| OPT-G | Landed | Kill / surface |
|-------|--------|----------------|
| **G1** | docs close F + open G | board / ledger / inventory |
| **G2** | CSS final tiny residual ~15→0 | style residual；FirstRunWizard deferred → H2 |
| **G3** | useAgentStream + useSlashSend → root | kill **#6** progress；useSlashSend tests；stop/stream keep |
| **G4** | openTool + layoutRestorePolicy + treePanelAccess → root | kill **#6** progress；same-store skip；cold-start tree；292 shell/tree tests |
| **G5** | ChatHeader + useChatPanelSync + useGoalMode → root | kill **#6** progress |
| **G6** | SessionSyncService + workspaceLayoutStore → root | kill **#6** progress |
| **G7** | SessionFacade pin/unpin/archive/unarchive/branch + sidebar menu | kill **#6** progress；44 tests |
| **G8** | Dead dual-path delete（git/ unused api；SettingsUI Tooltip re-export） | cleanup |
| **post-G hotfix** | useChatHandlers arity / hydrate immer / message-identity / parseCodex | `tsc -b desktop` 0 err |

### OPT-H land map（2026-07-29 — **complete / landed**）

| OPT-H | Landed | Kill / surface |
|-------|--------|----------------|
| **H1** | Docs close G + open H | board / ledger / inventory — **done** |
| **H2** | FirstRunWizard.module.css residual hex → **0** | style residual（G2 deferred **closed**） |
| **H3** | TSX inline hex high-traffic ~52→**0** | style residual；Terminal **xterm ANSI** residual noted |
| **H4** | Document stream setState residual（choice B；**no patchState / no god rewrite**） | kill **#6** residual **intentional**；note `opt-h4-layout-setstate-residual.md` |
| **H5** | mcpBridge → compositionRoot | kill **#6** residual slice **done** |
| **H6** | Inventory/board kill-list refresh after G | docs — **G3–G7 done**（H6 误标 in flight → **corrected DONE**） |
| **H7** | FirstRunWizard + import residual polish | import/wizard **66 tests**；`hasCustomImportRoot` UX |
| **H8** | system-map compositionRoot pin/archive methods | docs — pin/archive facade |

---

## Top 10 kill-list

| # | Dual path | Canonical | Delete / merge | Priority | Owner package |
|---|-----------|-----------|----------------|----------|---------------|
| 1 | ~~**Session create fan-out**~~ **DONE (OPT-B2)**: user「新对话」→ `shell.openNewDraftTab` / `session.enterDraft` only; `createSessionAndOpenChat` **@deprecated** shim (enterDraft only); slash **no** `createSessionCmd` fallback | **Pending Draft ADR**: user entry → `enterDraftMode` only; real id only via `commitDraftIfNeeded` or system `createSession({ id, title, activate:false })` | ✅ UI merged to compositionRoot draft APIs. ✅ `createSessionAndOpenChat` deprecated → enterDraft. ✅ Ban product empty-shell mint (schedule/import/test keep `createSession`). ✅ Slash uses `commitDraftIfNeeded` only. | **P0** | `apps/crish-desktop` (`store/sessionCrudActions.ts`, `api/store-access/sessionAccess.ts`, `store/workspace-shell/workspaceShellStore.ts`, `hooks/chat-stream/useSlashSend.ts`, sidebar/strip) |
| 2 | ~~**Layout identity dual**~~ **PARTIAL (OPT-C1 + OPT-E9)**: ownership **documented** in package headers + `storeOwnership.ts` + store README + composition docs; **OPT-E9** ownershipEnforce (11) + compositionRoot (17) = **28 pass**. Sessions still on layoutStore (**no god split** — H4 forbids god rewrite). Residual: dual-write call sites if any; stream setState **intentional residual**（**OPT-H4 documented**） | **Split ownership (master §2 / D1):** session identity + messages → session facade on layout instance; open tabs / unit bind → `workspaceShellStore`; geometry → `layoutTreeStore` | ✅ Write-owner matrix in code comments + `store/storeOwnership.ts` + `docs/architecture/desktop-composition-and-stores.md`. ✅ compositionRoot shell vs **layout** (≠ layout-tree) naming clarified. ✅ **OPT-E9** call-site enforce tests landed. ✅ **OPT-H4** stream setState residual **documented intentional**（choice B；no patchState）. ⬜ Residual dual-write call sites if any remain. | **P0→partial** | `apps/crish-desktop` (`store/layoutStore.ts`, `store/storeOwnership.ts`, `store/sessionStore.ts`, `store/workspaceStore.ts`, `store/workspace-shell/*`, `store/layout-tree/*`, `app/compositionRoot.ts`) |
| 3 | **Stop UI dual stacks**: main chat `useStreamCallbacks.finalizeStopGeneration` → `safeCancelStream` **vs** agent `useAgentStream.finalizeAgentStop` → local `cancel` **+** (legacy cancelDaemonRun) | **Product:** default Stop = L2, Force = L3 ([`docs/architecture/run-control.md`](../../architecture/run-control.md)). **Wire:** single client entry `compositionRoot.runControl` / `createStreamCancel` | **OPT-B7 partial + OPT-C6：** shared `api/streamStop`（`dispatchStreamStopCancel` + `markStreamingActive`）chat + agent L2/L3 wire. Agent live stream **only** `StreamCancelFn`; no-stream fallback `requestAgentRunStop` → root. Full hook merge deferred to #7. | **P0→partial** | `apps/crish-desktop` (`api/streamStop`, `hooks/chat-stream/useStreamCallbacks.ts`, `hooks/chat-stream/helpers.ts`, `hooks/useAgentStream.ts`, `api/daemon-chat-bridge/ConnectionLifecycle.ts`, `api/runControlClient.ts`) |
| 4 | ~~**Stop wire dual**（散落）~~ → **single helper + flag（OPT-B7）** | **Canonical protocol:** `run-control` L2/L3 (`packages/shared-types` + daemon ControlBus). `cancel-run` is **transition only** | ✅ **OPT-B7:** 唯一 helper `sendTerminateDualWire` + flag `TRANSITIONAL_DUAL_CANCEL_RUN_WIRE`（metrics once）。**Delete** dual body when daemon L2 full + E0 live Stop（flag → false 后删路径）. | **P0→flagged (helper done)** | `apps/crish-desktop` (`api/runControlClient.ts`) + `packages/agent-daemon` + `packages/agent-runtime` control |
| 5 | ~~**Markdown SoT dual**（InlineAgentPanel sync）~~ **DONE (OPT-B6)** for completed product UI | **Completed chat SoT:** Rust via `AsyncMarkdownBlock` → `useAsyncMarkdownHtml`. Stream: plain + `markdownRenderLite`. Sync/worker: **fallback only** (no live chat SoT) | ✅ InlineAgentPanel completed path → `AsyncMarkdownBlock`. Keep sync parser for worker/offline + parity tests only. Do **not** byte-equal Rust↔TS (W10-4 policy). D0 residual = “fallback retained, not second SoT”. | **P1→done (product)** | `apps/crish-desktop` (`api/markdownRender*.ts`, `components/chat-message-row/AsyncMarkdownBlock.tsx`, `components/InlineAgentPanel.tsx`, `workers/*`) + `crates/conex-markdown` |
| 6 | **getState scatter vs compositionRoot**: command paths **near done**（B3；**G3–G7 done**；**H5 mcpBridge done**；**H4 setState intentional residual** + any leftover strip） | **B3:** command-ish cross-module writes/reads go through `apps/crish-desktop/src/app/compositionRoot.ts` facades (`session` / `shell` / `runControl` / `pty` / `metrics` / `layout` / **tree thin** / **pin·archive·branch** / **mcpBridge**) | ✅ **OPT-B4:** `navigation-keys` → `root.layout`. ✅ **OPT-D3:** `compositionRoot.tree` **thin**（`getState` + `setLeafSessionId`；hydrate 用 `root.tree`）。✅ **OPT-E5–E7:** `layout.setAppSettings` + AppBootstrap（E5）、sidebar command paths（E6）、`openAgentPanel` + `workspaceChromeHooks` → root（E7）。✅ **OPT-F4–F6 done:** useStreamCallbacks → layout/session（F4；14 chat-stream tests）、useToolDockTabDrag + useTopBarDrag（F5；86 drag tests）、useTreeResize + useChatHandlers（F6；42 tests）。✅ **OPT-G3–G7 done:** useAgentStream + useSlashSend（G3）、openTool + layoutRestorePolicy + treePanelAccess（G4；292 shell/tree tests）、ChatHeader + useChatPanelSync + useGoalMode（G5）、SessionSyncService + workspaceLayoutStore（G6）、SessionFacade pin/unpin/archive/unarchive/branch + sidebar menu（G7；44 tests）。✅ **OPT-H5 done:** mcpBridge → compositionRoot。✅ **OPT-H4 done（document only）：** stream layout.setState residual **intentional**（choice B；**no patchState / no god rewrite**；note `opt-h4-layout-setstate-residual.md`）。⬜ Any leftover strip / pure selectors as store hooks may remain. | **P1→near-done** | `apps/crish-desktop` (`app/compositionRoot.ts`, `hooks/keyboard/navigation-keys.ts`, `api/openAgentPanel.ts`, `components/workspaceChromeHooks.ts`, `components/sidebar/*`, `components/binary-tree/*`, `hooks/chat-stream/*`, `hooks/useAgentStream.ts`, `app/AppBootstrap.ts`, `app/hydrateWorkspaceShell.ts`, `store/workspace-shell/openTool.ts`, `store/workspace-shell/layoutRestorePolicy.ts`, `store/layout-tree/treePanelAccess.ts`, `services/SessionSyncService.ts`, `api/workspaceLayoutStore.ts`) |
| 7 | **Stream product dual**: `hooks/chat-stream/*` + `useChatStream` (main ChatCard) **vs** `hooks/useAgentStream` (AgentCard / InlineAgentPanel) — separate batchers, stop, send, store patch styles | **One run-control + one stream cancel contract**; two UIs may stay | **OPT-C6 partial land:** shared `api/streamStop` for L2/L3 wire. Still extract/share cancel + runId binding via `createStreamCancel` + `runControlClient`. **Do not** force full hook merge in one wave. Subagent keep thinner UI surface on shared core. | **P1→partial** | `apps/crish-desktop` (`api/streamStop`, `hooks/chat-stream/*`, `hooks/useAgentStream.ts`, `api/daemonChatBridge.ts`, `api/subagentApi.ts`) |
| 8 | ~~**session-actions leftovers**~~ **DONE (OPT-E8)** — **closed；H does not re-open**: code tree **deleted** (W4-2 ledger); analysis/plans stale paths **purged** (docs-only) | Canonical modules: `sessionCrudActions.ts` / `sessionMessageActions.ts` / `sessionOrderingActions.ts` / `sessionAgentActions.ts` / barrel `sessionActions.ts` | ✅ **OPT-E8 docs purge done:** rewrite/archive stale paths in `analysis/**`, `docs/**`; note `opt-e8-session-actions-docs-purge.md`. Mark `docs/architecture/workbench-session-actions-and-split-view.md` as product-actions doc (not the deleted dir). No residual. | **P1→done** | `docs/**` + `analysis/**` (no product package) |
| 9 | ~~**Empty-shell residual vs Pending Draft**~~ **DONE (OPT-C2)**: single mental model — new chat = draft only; empty shells = hydrate GC only | **New chat:** draft sentinel only (`store/draftSession.ts`). **Hydrate:** prune non-active empty shells only | ✅ Documented in `sessionTitle` / `prepareSessionsForUi` / `emptyShellAssert` / ADR §4. ✅ No product path mints titled「新会话」for new chat (enterDraft / openNewDraftTab). ✅ Schedule uses non-default titles. ✅ Tests: I-DRAFT strip + draft-active GC + assert keep rules. | **P1→done** | `apps/crish-desktop` (`api/sessionTitle.ts`, `store/sessionIndex.ts`, `dev/emptyShellAssert.ts`, schedule components) |
| 10 | ~~**Stream transport dual**~~ **PARTIAL (OPT-C3 + OPT-F7 metric done)**: production `streamViaDaemon` **vs** disconnect fallback `streamViaDirectFetch` (auto from `ConnectionLifecycle`) | **Primary:** daemon WS (`chatApi` → `streamViaDaemon`). Direct fetch = **degraded** only | ✅ Module SoT headers + decision tree on `chatApi` / `ConnectionLifecycle` / `directFetchBridge` / facade. ✅ **Single switch** `ALLOW_AUTO_DIRECT_FETCH_FALLBACK` (default `true`, soft-deprecated auto). ✅ Cancel parity: degraded abort stored on `state.transportAbort`; outer `createStreamCancel` aborts HTTP + documents force-equivalent (no L2). ✅ **OPT-F7 residual metric done:** `recordTransportDegradedDirectFetch` → metric `transport_degraded_direct_fetch` + one-shot dev `console.info` notice on first degrade（flag **stays true**）. ⏳ **Only residual:** **flag flip** `false` when offline UX is productized. **Do not delete** `directFetchBridge` (alive degraded + tests/helpers). OPT-H does **not** re-open transport SoT. | **P1→partial**（F7 **done**；flag flip residual） | `apps/crish-desktop` (`api/daemon-chat-bridge/ConnectionLifecycle.ts`, `api/directFetchBridge.ts`, `api/chatApi.ts`, `api/controlMetrics.ts`) |

---

## Concrete path anchors (by item)

### 1 — Session create

| Role | Path |
|------|------|
| ADR | `docs/architecture/session-pending-draft-adr.md` |
| Draft sentinel | `apps/crish-desktop/src/store/draftSession.ts` |
| Store create / enter / commit | `apps/crish-desktop/src/store/sessionCrudActions.ts` |
| Facade (compat, **@deprecated**) | `apps/crish-desktop/src/api/store-access/sessionAccess.ts` (`createSessionAndOpenChat` → enterDraft only; no mint) |
| Shell new draft | `apps/crish-desktop/src/store/workspace-shell/workspaceShellStore.ts` (`openNewDraftTab`) |
| Composition entry | `apps/crish-desktop/src/app/compositionRoot.ts` (`session.enterDraft`, `shell.openNewDraftTab`) |
| Slash first-send | `apps/crish-desktop/src/hooks/chat-stream/useSlashSend.ts` (`commitDraftIfNeeded` only; no `createSession` fallback) |
| System placeholder OK | `apps/crish-desktop/src/components/SettingsScheduleTab.tsx` (`createSession({ activate:false })`) |

### 2 — Layout dual (OPT-C1 partial + OPT-E9 ownership gate)

| Role | Path |
|------|------|
| God store | `apps/crish-desktop/src/store/layoutStore.ts` |
| Ownership tags | `apps/crish-desktop/src/store/storeOwnership.ts` |
| Store README matrix | `apps/crish-desktop/src/store/README.md` (§ Layout identity ownership) |
| Composition + ownership guide | `docs/architecture/desktop-composition-and-stores.md` (§ Layout identity ownership) |
| Session facade (= layout) | `apps/crish-desktop/src/store/sessionStore.ts` |
| Workspace facade (= layout) | `apps/crish-desktop/src/store/workspaceStore.ts` |
| TabSurface / dock | `apps/crish-desktop/src/store/workspace-shell/workspaceShellStore.ts` |
| Geometry tree | `apps/crish-desktop/src/store/layout-tree/layoutTreeStore.ts` |
| Composition facades | `apps/crish-desktop/src/app/compositionRoot.ts` (`.layout` ≠ layout-tree；**G7** pin/archive/branch) |
| Hydrate both | `apps/crish-desktop/src/app/hydrateWorkspaceShell.ts` |
| **E9 ownership** gate | ownershipEnforce + compositionRoot tests（**OPT-E9** 28 pass）；H4 does **not** re-open god split |

### 3–4 — Stop / cancel

| Role | Path |
|------|------|
| Chat stop | `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts` (`finalizeStopGeneration`) |
| Safe cancel | `apps/crish-desktop/src/hooks/chat-stream/helpers.ts` (`safeCancelStream`) |
| Agent stop | `apps/crish-desktop/src/hooks/useAgentStream.ts` (`finalizeAgentStop`, `requestAgentRunStop` fallback) |
| Stream cancel factory | `apps/crish-desktop/src/api/daemon-chat-bridge/ConnectionLifecycle.ts` (`createStreamCancel`) |
| Dual wire client | `apps/crish-desktop/src/api/runControlClient.ts` (`sendTerminateDualWire` + `TRANSITIONAL_DUAL_CANCEL_RUN_WIRE`) |
| Shared stop helper（**OPT-C6**） | `apps/crish-desktop/src/api/streamStop`（`dispatchStreamStopCancel` + `markStreamingActive`） |
| Contract | `docs/architecture/run-control.md`, `packages/shared-types/src/run-control.ts` |

### 5 — Markdown

| Role | Path |
|------|------|
| Async SoT | `apps/crish-desktop/src/api/markdownRenderAsync.ts` |
| Sync fallback | `apps/crish-desktop/src/api/markdownRender.ts` |
| Stream lite | `apps/crish-desktop/src/api/markdownRenderLite.ts` |
| UI SoT block | `apps/crish-desktop/src/components/chat-message-row/AsyncMarkdownBlock.tsx` |
| Inline agent (**OPT-B6 done**) | `apps/crish-desktop/src/components/InlineAgentPanel.tsx` → `AsyncMarkdownBlock` (completed) |
| Worker = TS sync fallback | `apps/crish-desktop/src/workers/markdown-render-standalone.ts` |
| Parity residual | `docs/plans/progress/d0-md-fixture-parity.md` |

### 6 — compositionRoot

| Role | Path |
|------|------|
| Root | `apps/crish-desktop/src/app/compositionRoot.ts` |
| W9 sidebar done | `components/sidebar/useSidebarHandlers.ts`, `session-list/*` |
| **OPT-B4** navigation | `hooks/keyboard/navigation-keys.ts` → `getCompositionRoot().layout` |
| **OPT-D3** tree facade | `compositionRoot.tree` **thin**（layout-tree：`getState` + `setLeafSessionId`）— **done**；hydrate 用 `root.tree`；UI drag 仍 hooks |
| **OPT-E5** setAppSettings | `layout.setAppSettings` facade + AppBootstrap optional prop fallback — **done** |
| **OPT-E6** sidebar commands | `useSidebarContextMenu` / handlers → compositionRoot session/shell — **done** |
| **OPT-E7** agent panel / chrome | `api/openAgentPanel` + `workspaceChromeHooks` → root session/workspace/shell — **done** |
| **OPT-F4–F6 done** | useStreamCallbacks → layout/session；useToolDockTabDrag / useTopBarDrag；useTreeResize / useChatHandlers |
| **OPT-G3–G7 done** | useAgentStream + useSlashSend；openTool + layoutRestorePolicy + treePanelAccess；ChatHeader + useChatPanelSync + useGoalMode；SessionSyncService + workspaceLayoutStore；SessionFacade pin/unpin/archive/unarchive/branch + sidebar menu |
| **OPT-H5 done** | mcpBridge → compositionRoot |
| Residual scatter（**OPT-H4 intentional**） | stream layout.setState residual **documented intentional**（choice B；**no patchState / no god rewrite**；`opt-h4-layout-setstate-residual.md`）；any leftover strip may remain |

### 7 — Stream stacks

| Role | Path |
|------|------|
| Main | `apps/crish-desktop/src/hooks/useChatStream.ts` → `hooks/chat-stream/` |
| Agent | `apps/crish-desktop/src/hooks/useAgentStream.ts` |
| Shared stop（**OPT-C6**） | `apps/crish-desktop/src/api/streamStop`（`dispatchStreamStopCancel` + `markStreamingActive`） |
| Dual cancel flag（**still transitional**） | `api/runControlClient.ts` → `TRANSITIONAL_DUAL_CANCEL_RUN_WIRE` default `true` |
| Consumers | `components/chat-card/useChatComposerProps.ts`, `components/AgentCard.tsx`, `components/InlineAgentPanel.tsx` |

### 8 — session-actions leftovers (docs) — **DONE OPT-E8**

| Status | Path pattern |
|--------|----------------|
| **Deleted** | `apps/crish-desktop/src/store/session-actions/` (absent; W4-2) |
| **Purged** | stale refs in `analysis/**`, `docs/**` — **OPT-E8 done**（note `opt-e8-session-actions-docs-purge.md`） |
| Live replacements | `sessionCrudActions.ts`, `sessionMessageActions.ts`, `sessionOrderingActions.ts`, `sessionAgentActions.ts`, `sessionActions.ts` |

### 9 — Empty shell residual

| Role | Path |
|------|------|
| List rules | `apps/crish-desktop/src/api/sessionTitle.ts` (`isEmptyShellSession`, `shouldListSessionInSidebar`) |
| Index flags | `apps/crish-desktop/src/store/sessionIndex.ts` |
| Dev assert | `apps/crish-desktop/src/dev/emptyShellAssert.ts` |

### 10 — Transport

| Role | Path |
|------|------|
| Primary entry | `apps/crish-desktop/src/api/chatApi.ts` → `streamViaDaemon` |
| Primary + flag | `apps/crish-desktop/src/api/daemon-chat-bridge/ConnectionLifecycle.ts` (`ALLOW_AUTO_DIRECT_FETCH_FALLBACK`, `createStreamSession`, `createStreamCancel`) |
| Facade export | `apps/crish-desktop/src/api/daemonChatBridge.ts` |
| Degraded HTTP SSE | `apps/crish-desktop/src/api/directFetchBridge.ts` (`streamViaDirectFetch` @deprecated as product primary) |
| Abort slot | `apps/crish-desktop/src/api/daemon-chat-bridge/handlers/streamState.ts` (`transportAbort`) |
| **OPT-F7 metric done** | `recordTransportDegradedDirectFetch` + `transport_degraded_direct_fetch` metric；one-shot dev console notice；flag stays true（only residual = flag flip + offline UX） |

**Decision tree (when directFetch):** daemon `waitUntilConnected(1.5s)` fails **or** `!isConnected()` → if flag true, `streamViaDirectFetch` + `state.transportAbort`; if flag false, `onRunError` + finish.

---

## Master-plan residual (still open)

From [`system-control-ledger.md`](./system-control-ledger.md) + OPT board (2026-07-29). **Do not re-open closed waves.**

| ID | Residual | Relates to kill # |
|----|----------|-------------------|
| **E0** | Still **partial**（**do not invent PASS**）: live model send re-verify / live stream Stop / full `check:desktop`；multi-unit **PASS**（W10）；**勿**标 live send PASS | 1, 3, 2 |
| **B3 / kill #6** | compositionRoot **near done**；sidebar W9 + **OPT-B4** + **D3 tree** + **E5–E7** + **F4–F6** + **G3–G7 done** + **H5 mcpBridge done**；**H4 stream setState intentional residual**（documented；no patchState）；any leftover strip may remain | 6 |
| **D0** | Product completed MD SoT **OPT-B6 done**；fixture parity residual (W10-4)；conex-stream eval deferred | 5 |
| **D2** (master health) | Health pack + overlay done; **OTel / traceId e2e / formal health UI** optional residual | — |
| **Wave 10** | paused as primary；send HOTFIX-1 + daemon 重启 re-verify；multi-unit **PASS** | 1–4, 2 |
| **Stop wire #4** | **OPT-B7 helper+flag done** + **OPT-C6 streamStop**；dual cancel flag **still transitional**；dual body delete still **gated** on E0 live Stop | 3, 4, 7 |
| **kill #2 ownership** | **E9 ownership gate landed**（28 pass）；residual dual-write call sites if any；**no** god-store re-split（H4 documented intentional residual；forbids god rewrite） | 2 |
| **kill #8** | **done（E8）** — H did not re-open | 8 |
| **Transport #10 residual** | **OPT-F7 metric done**；only residual = **flag flip** + offline UX（flag **still true**） | 10 |
| **Shell residual** (side plan) | live resize paint (S4.3)；stream dual-sub **OPT-7 done 4→2**；pin sub **OPT-D8 done**（`allMessages` prop） | 2, 7 |
| **Style residual after H** | Terminal **xterm ANSI**（not token CSS）；H2/H3 token hex closed | — |
| **Out of master mainline** | process-out hooks; PTY cross-platform orphan policy beyond W6-2 | — |
| **OPT-B** | **complete**（B1–B7） | — |
| **OPT-C** | **complete**（C1–C8）；kill #9 done；#2/#10 partial；#3/#7 + streamStop | — |
| **OPT-D** | **complete**（D1–D8）；tree facade / Tooltip / tokens / import roots / pin perf / docs landed | 2, 6, 10 |
| **OPT-E** | **complete**（E1–E9）；CSS §12–14；E5–E7 root migrate；kill **#8 done**；#2 E9 tests；#6 E5–E7 progress | 2, 6, 8 |
| **OPT-F** | **complete**（F1–F8）；CSS §15–16；F4–F6 root migrate；**F7 metric done**（kill #10 residual metric；flag flip residual）；F8 system-map + inventory + composition docs | 6, 10 |
| **OPT-G** | **complete**（G1–G8）；CSS ~15→0；**G3–G7 done**；G8 dead dual-path delete；post-G hotfix `tsc -b desktop` 0 err | 6 |
| **OPT-H** | **complete**（H1–H8）；H2 CSS→0；H3 TSX ~52→0；H4 setState intentional docs；H5 mcpBridge done；H6 G3–G7 **done** corrected；H7 66 tests + hasCustomImportRoot；H8 pin/archive map | 6 |

---

## Explicit non-goals (this inventory)

- No new product features or stores.
- No full rewrite of `layoutStore` in one wave (ownership rules first).
- No forcing Rust↔TS markdown byte equality.
- No deleting `cancel-run` before daemon L2 acceptance is proven in E0 live Stop.

---

## Suggested kill order

```
~~P0-1 Session create single entry (names + slash fallback)~~ **DONE OPT-B2**
~~P0-4 Stop wire single helper + transitional flag~~ **DONE OPT-B7**（delete dual body still gated；flag **still transitional**）
P0-3 Stop stack full hook merge（#7）— partial via OPT-B7 agent StreamCancelFn + **OPT-C6 streamStop**
~~P0-2 Layout write-owner matrix (docs + package headers)~~ **PARTIAL OPT-C1 + OPT-E9**（E9 tests 28 pass；residual dual-write if any；H4 forbids god rewrite）
~~P1-5 InlineAgentPanel → AsyncMarkdownBlock; sync fallback-only~~ **DONE OPT-B6**
~~P1-6 compositionRoot migrate agent/slash/tool/header/session~~ **DONE OPT-G3–G7**（+ **B4** / **D3** / **E5–E7** / **F4–F6**）+ **OPT-H5 mcpBridge done**；**OPT-H4** stream setState residual **intentional documented**
P1-7 Shared cancel primitive between chat-stream and useAgentStream（**OPT-C6** streamStop partial）；dual cancel body still **gated** E0 live Stop
~~P1-9 Empty-shell narrative cleanup (hydrate-only)~~ **DONE OPT-C2**
~~P1-10 Transport SoT + cancel parity + F7 metric~~ **PARTIAL OPT-C3 + OPT-F7** (metric **done**；flag still true；**flag flip residual**)
~~P1-8 Docs purge session-actions paths~~ **DONE OPT-E8**（closed；H did not re-open）
```

---

## Acceptance for “dedup done” (slice-level)

| Slice | Done when |
|-------|-----------|
| Create | ✅ User new-chat call graph only hits compositionRoot shell/session draft APIs; no product `createSession()` without explicit id/title/activate:false; slash = `commitDraftIfNeeded` only；`createSessionAndOpenChat` deprecated |
| Stop | Chat + agent Stop both L2-default / L3-force; one metrics path；✅ dual wire via **single** `sendTerminateDualWire` + flag（delete body still **gated** E0 live Stop） |
| Layout | ✅ Ownership table in comments/`storeOwnership`/docs (OPT-C1). ✅ **E9 ownership** enforce tests (OPT-E9, 28 pass). ⬜ Residual dual open paths if any remain；H4 **documented intentional** setState residual；**no** god split |
| MD | ✅ Completed messages never call sync `parseMarkdownToHtml` on main chat/**InlineAgentPanel** completed path（OPT-B6） |
| B3 | New command paths use compositionRoot；✅ navigation-keys（B4）；✅ tree（D3）；✅ setAppSettings/sidebar/openAgentPanel（E5–E7）；✅ stream/drag/tree+chatHandlers（F4–F6）；✅ agent/slash/tool/header/session/pin-archive-branch（**G3–G7 done**）；✅ mcpBridge（**H5 done**）；✅ stream setState residual **intentional documented**（**H4**）；⬜ any leftover strip may remain |
| Docs | ✅ session-actions stale path purge（**#8 DONE OPT-E8**；H did not re-open） |
| Transport | ✅ daemon primary + flag + cancel parity（C3）；✅ **F7 metric/notice done**；⬜ **flag flip residual**（flag **still true**） |

**Progress truth:** update [`system-control-ledger.md`](./system-control-ledger.md) when a kill row lands; this file is the **dedup kill-list**, not the wave ledger.
