# Desktop Composition Root & Stores

**Scope:** `apps/crish-desktop`
**Status:** living guide (B3 partial → layout + **tree thin** + **setAppSettings** facades; OPT-C1 ownership docs; OPT-E5–E7 command migrate; **OPT-G7** session pin/unpin/archive/unarchive/branch)
**Code:** `src/app/compositionRoot.ts`, `src/bootstrap-services.ts`, `src/store/storeOwnership.ts`

## Purpose

Bootstrap, shortcuts, hydrate, and shell/session command paths should not scatter `useXStore.getState()` deep across the app. A **light composition root** registers named facades once at startup. Components that **render** still use Zustand hooks with narrow selectors — we do **not** force React DI.

## When to use `getCompositionRoot()`

| Use compositionRoot | Prefer direct store / hook |
| --- | --- |
| Imperative mutations from bootstrap, shortcuts, keyboard, IPC handlers | React render: `useLayoutStore(s => s.foo)` |
| Cross-domain orchestration (open draft tab, run control L1/L2/L3, PTY killAll) | Local UI state that is not shell/session lifecycle |
| App exit / pagehide kill-all | High-frequency stream token patches (streaming store / layout message paths) |
| Tests that need to override one facade | Store unit tests that seed state via `setState` |

**Rule of thumb:** if the call is a **command** (“open new draft”, “stop run”, “set tab mode on boot”), go through compositionRoot. If it is a **subscription for paint**, use a selector.

## Store map

```text
┌──────────────────────────────────────────────────────────────────────────┐
│                     getCompositionRoot()                                 │
│  registerCompositionRoot()  ← bootstrap-services (once)                  │
├─────┬────────┬───────┬────────┬──────────┬──────┬───────────┬────────────┤
│ pty │session │ shell │ layout │ workspace│ tree │runControl │  metrics   │
│kill │enter   │openNew│sessions│ getState │getSt │ L1/L2/L3  │ snapshot   │
│All  │Draft   │Draft  │tabMode │          │setLeaf│          │ record     │
│     │openOr  │setReady│sidebar│          │SessId│           │            │
│     │Focus   │getSt  │planMode│          │ thin │           │            │
│     │pin/un  │       │**setApp│          │      │           │            │
│     │pin     │       │Settings│          │      │           │            │
│     │archive/│       │        │          │      │           │            │
│     │unarch  │       │        │          │      │           │            │
│     │branch  │       │        │          │      │           │            │
└──┬──┴───┬────┴───┬───┴───┬────┴────┬─────┴──┬───┴─────┬─────┴─────┬──────┘
   │      │        │       │         │        │         │           │
   ▼      ▼        ▼       ▼         ▼        ▼         ▼           ▼
 pty   session  workspace layoutStore workspace layout-  runControl control
Registry /enter  -shell   (god chrome Store    tree     Client     Metrics
         Draft            +sessions)         geometry
         +pin/arch/branch
```

**Naming:** `.layout` ≠ layout-tree; `.tree` is geometry (leaf↔session bind). BinaryTree UI keeps `useLayoutTreeStore` selectors — only hydrate/bootstrap use `.tree`.

**`layout.setAppSettings` (OPT-E5):** settings boot / AppBootstrap **command** path writes appSettings via `getCompositionRoot().layout.setAppSettings` (optional React prop setter kept for backward compat). Do not scatter `useLayoutStore.getState().setAppSettings` from new bootstrap/command code.

### Domain roles

| Store / module | Owns | Facade | Alias? |
| --- | --- | --- | --- |
| `layoutStore` | Sessions list + messages, UI chrome (sidebar, tab mode, plan mode), **appSettings** (`setAppSettings` / `getAppSettings` on facade), legacy columns | `layout` | — (god instance) |
| `workspace-shell` | Open tabs, draft tab, rightDock, shellReady | `shell` (+ `session.openOrFocusSession`) | separate store |
| `sessionStore` / storeAccess | Active session, enterDraft, **pin/unpin/archive/unarchive/branch** (API on layout instance) | `session` | **alias of layoutStore** |
| `workspaceStore` | Columns / groups (legacy workspace cards) | `workspace` | **alias of layoutStore** (≠ shell) |
| `layout-tree` | Binary layout tree, tool column geometry | `tree` (thin: getState + setLeafSessionId) | separate store (**≠** `layout` facade) |
| `ptyRegistry` | PTY session bindings | `pty` | — |
| `runControlClient` | Soft stop / force cancel / follow-up | `runControl` | — |
| `controlMetrics` | Counters for control plane | `metrics` | — |

See **Layout identity ownership (OPT-C1)** below for forbidden dual-writes and naming traps.

## Lifecycle

```text
App mount
  → bootstrapServices()
      → registerCompositionRoot()
      → PTY handlers + pagehide → compositionRoot.pty.killAll
  → useAppBootstrap
      → waitLayoutTreeHydration → hydrateWorkspaceShell()
          → layout.getAppSettings / getSessions
          → tree.getState (geometry + setToolColumnCollapsed)
          → shell.setShellReady(true)
      → settings boot → layout.setTabModeEnabled
      → daemon ready → layout.getSessions / setSessions (sync)
  → useAppShortcuts
      → shell.openNewDraftTab | layout.toggleSidebar | layout.togglePlanMode
```

## Do / don't

**Do**

- `getCompositionRoot().shell.openNewDraftTab(projectId)` for 「新对话」
- `getCompositionRoot().layout.setTabModeEnabled(...)` from bootstrap
- `getCompositionRoot().layout.setAppSettings(...)` from settings boot / AppBootstrap command path（OPT-E5）
- `getCompositionRoot().session.pinSession` / `unpinSession` / `archiveSession` / `unarchiveSession` / `branchSession` for sidebar menu commands（OPT-G7；**not** on `layout`）
- `getCompositionRoot().runControl.cooperativeStop(...)` for Stop
- Override a single facade in unit tests via `registerCompositionRoot({ layout: fake })`

**Don't**

- Inject the root into every component props tree (no React context DI required)
- Replace every `useLayoutStore(selector)` with `getCompositionRoot().layout.getState()` — that breaks fine-grained re-render
- Put pin / archive / branch on `layout` facade — they live on **`session`** only（OPT-G7）
- Kill PTYs on dock fold; only exit / closeTab / reset → `pty.killAll`
- Mint empty sessions for “new chat”; use `shell.openNewDraftTab` / `session.enterDraft`

## Migration status (bootstrap / App / hydrate)

Migrated command paths (examples):

- `AppBootstrap`: tabMode, session rebind snapshot, daemon session sync, **`layout.setAppSettings`** (OPT-E5; optional prop fallback)
- `useEngineBootstrap`: daemon session sync
- `AppShortcuts`: new draft, sidebar toggle, plan mode, branch active id
- `hydrateWorkspaceShell`: appSettings read, sessions for restore map, `tree.getState`, setShellReady
- Sidebar / strip / chat card empty: openNewDraftTab / openOrFocusSession
- **OPT-E6:** `useSidebarContextMenu` / residual sidebar handlers → `root.session` / `root.shell`
- **OPT-E7:** `api/openAgentPanel` + `workspaceChromeHooks` → `root.session` / `root.workspace` / `root.shell`
- **OPT-G7:** `SessionFacade` expands pin/unpin/archive/unarchive/branch；sidebar context menu → `root.session.pinSession` / `unpinSession` / `archiveSession` / `unarchiveSession` / `branchSession`（**not** on `layout`；ownershipEnforce asserts layout 无这些 key）
- Stop wire shared helper: `api/streamStop` → `compositionRoot.runControl`（dual cancel flag still transitional）

## Remaining debt

| Area | Pattern | Notes |
| --- | --- | --- |
| BinaryTree / drag / resize UI | `useLayoutTreeStore` hooks + getState | intentional; not forced through DI（tree facade stays **thin**） |
| `AppBootstrap` rebind | `useLayoutStore.setState` + `subscribe` | subscription OK; setState rebind is bulk patch |
| Stream / message hot path | `useLayoutStore.getState()` in chat-stream | intentional; OPT-F4 may narrow command-ish edges |
| Settings tabs / ModelPicker | appSettings getState | feature UI residual |
| Strip / tool-dock drag / tree resize | residual getState | OPT-F4–F6 migrate targets |
| Dev MCP bridge | direct workspace-shell getState | dev-only |

## Layout identity ownership (OPT-C1)

Write owners for “what is open / where painted / session body”. **Do not dual-write** the same user gesture across owners.

| Concern | Write owner | compositionRoot | Notes |
| --- | --- | --- | --- |
| Session list, messages, agents, `activeSessionId` field；**pin / archive / branch** | **layoutStore** via session facade (`sessionStore` = **alias**, same instance) | `.session` (read + enterDraft + **pin/unpin/archive/unarchive/branch** OPT-G7); activate often via shell | Sessions **still on god layoutStore** — no mass split this wave；pin/archive/branch **only** on `.session`，never `.layout` |
| Open tabs, TabSurface, rightDock, shellReady | **workspaceShellStore** | `.shell` | open/focus/new-draft/close **only** here |
| Binary tree geometry, activeLeaf, history | **layoutTreeStore** | `.tree` (thin) | Hydrate/bootstrap only; UI keeps hooks |
| UI chrome (sidebar, tabMode, planMode), appSettings | **layoutStore** | `.layout` | **Not** layout-tree |
| Legacy columns/groups/cards | **layoutStore** via workspace facade | `.workspace` | **≠** workspace-shell |

### Naming trap: `layout` facade ≠ layout-tree

`.layout` ≠ layout-tree; `.tree` is geometry.

```text
compositionRoot.layout  →  useLayoutStore   (god: sessions + chrome + settings)
compositionRoot.shell   →  workspaceShellStore  (tabs / dock)
compositionRoot.session →  session facade + openOrFocus → shell + pin/archive/branch (OPT-G7)
compositionRoot.workspace → workspace facade (= layoutStore slice)
compositionRoot.tree    →  useLayoutTreeStore (geometry + leaf↔session; thin)
```

### Forbidden dual-writes (new code)

- Open/focus/new-draft: **do not** call `setActiveSessionId` *and* shell activate from the component; one owner = **shell** (or `session.openOrFocusSession` → shell). Shell may call session activate internally.
- Tree: **do not** open a chat by only `setTree` / `setActiveLeaf` without shell TabSurface update.
- **Do not** invent a third layout store; facades are aliases of layoutStore.
- **Do not** write `openTabs` from layoutStore or layout-tree.

### Package headers / tags

- `apps/crish-desktop/src/store/layoutStore.ts`
- `apps/crish-desktop/src/store/workspace-shell/*`
- `apps/crish-desktop/src/store/layout-tree/*`
- `apps/crish-desktop/src/store/storeOwnership.ts` (`StoreOwnership`, `SHELL_TAB_OWNERSHIP`, …)
- `apps/crish-desktop/src/store/README.md` § Layout identity ownership

### Residual (not this wave)

- **OPT-E9** ownershipEnforce tests landed; residual dual-path strip vs sidebar call sites if any remain.
- BinaryTree UI / drag / resize still use `useLayoutTreeStore` directly (not DI；tree facade stays thin).
- layoutStore remains god-object for sessions (Phase 2 extract optional).
- Settings command path：prefer `layout.setAppSettings`（OPT-E5）over raw store setter from bootstrap.

## Related

- Master plan B3: `docs/plans/2026-07-system-architecture-control-master-plan.md`
- Dedup inventory #2: `docs/plans/progress/architecture-dedup-inventory.md`
- Multi-unit restore: `docs/architecture/multi-unit-layout-restore-adr.md`
- Session pending draft: `docs/architecture/session-pending-draft-adr.md`
- Run control levels: `docs/architecture/run-control.md`
