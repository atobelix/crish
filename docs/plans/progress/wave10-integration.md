# Wave 10 Integration Results (W10-INT)

**Agent:** Tester Agent W10-INT  
**Date:** 2026-07-29  
**Scope:** Targeted vitest after W8-1 soft steer, W8-3 follow_up queue, W9-DATA persistence fix, W9-B3 compositionRoot  
**Policy:** Fix only trivial test/product breakage; report pass/fail counts. No product feature work.

## Summary

| Package | Command slice | Test files | Tests | Failed | Status |
|---------|---------------|------------|------:|-------:|--------|
| `packages/agent-runtime` | runtime, agent-input-queue, control, session-loop, agent-session-loop | 7 | 81 | 0 | **PASS** |
| `apps/crish-desktop` | compositionRoot, runControlClient, useChatStream, chat-stream helpers, sessionPersistence, sessionActivateHydrate | 8 | 98 | 0 | **PASS** |
| `apps/crish-desktop` (sidebar, optional) | sidebar utils / measure / context menus — no dedicated `useSidebar*.test` | 3 | 15 | 0 | **PASS** |
| `packages/agent-daemon` | `src/handlers/run-control.test.ts` | 1 | 18 | 0 | **PASS** |
| **Core W10-INT slice** | (excl. optional sidebar) | **16** | **197** | **0** | **PASS** |
| **With optional sidebar** | | **19** | **212** | **0** | **PASS** |

- **Vitest (targeted):** all green — no product or test fixes required  
- **Trivial breakage fixed:** none  
- **useSidebar:** no dedicated test files (`useSidebarHandlers` / `useSidebarContextMenu` / `useSidebarResize` untested as units); related sidebar suite run optionally and green  
- **Context:** post W8-1/W8-3 queue + W9-DATA persistence + W9-B3 compositionRoot; smoke confirms soft steer / follow_up / hydrate / compositionRoot surfaces still pass

## Commands run

Root: `C:\Software\conex`. PowerShell. Vitest v3.2.7, `--coverage.enabled=false`.  
Workspace root resolve is fine for these path globs (unit project).

### agent-runtime

```powershell
npx vitest run packages/agent-runtime/src/runtime.test.ts packages/agent-runtime/src/agent-input-queue.test.ts packages/agent-runtime/src/control packages/agent-runtime/src/session-loop packages/agent-runtime/src/agent-session-loop.test.ts --coverage.enabled=false
```

### crish-desktop (core)

```powershell
npx vitest run apps/crish-desktop/src/app/compositionRoot.test.ts apps/crish-desktop/src/api/runControlClient.test.ts apps/crish-desktop/src/hooks/useChatStream.test.ts apps/crish-desktop/src/hooks/chat-stream apps/crish-desktop/src/api/sessionPersistence.test.ts apps/crish-desktop/src/store/sessionActivateHydrate.test.ts --coverage.enabled=false
```

### crish-desktop (sidebar optional)

```powershell
npx vitest run apps/crish-desktop/src/components/sidebar --coverage.enabled=false
```

### agent-daemon (run-control)

```powershell
npx vitest run packages/agent-daemon/src/handlers/run-control.test.ts --coverage.enabled=false
```

## Full pass/fail table

### packages/agent-runtime

| Suite | Path | Tests | Result | Notes |
|-------|------|------:|--------|-------|
| runtime | `src/runtime.test.ts` | 33 | PASS | |
| agent-input-queue | `src/agent-input-queue.test.ts` | 15 | PASS | W8-1 soft steer / W8-3 follow_up queue |
| control bus | `src/control/control-bus.test.ts` | 9 | PASS | L0–L3 |
| session-loop control-check | `src/session-loop/control-check.test.ts` | 5 | PASS | |
| session-loop index | `src/session-loop/index.test.ts` | 2 | PASS | |
| session-loop provider-call | `src/session-loop/provider-call.test.ts` | 1 | PASS | |
| agent-session-loop | `src/agent-session-loop.test.ts` | 16 | PASS | mid-stream salvage / control |

**agent-runtime subtotal: 81 / 81 pass** (7 files)

### apps/crish-desktop (core)

| Suite | Path | Tests | Result | Notes |
|-------|------|------:|--------|-------|
| compositionRoot | `src/app/compositionRoot.test.ts` | 13 | PASS | W9-B3 facades |
| runControlClient | `src/api/runControlClient.test.ts` | 6 | PASS | L1/L2/L3 dispatch |
| useChatStream | `src/hooks/useChatStream.test.ts` | 24 | PASS | send / queue / stream |
| chat-stream multimodal | `src/hooks/chat-stream/multimodal.test.ts` | 4 | PASS | |
| useStreamCallbacks | `src/hooks/chat-stream/useStreamCallbacks.test.ts` | 2 | PASS | |
| useStreamCallbacks streamStore | `src/hooks/chat-stream/useStreamCallbacks.streamStore.test.ts` | 8 | PASS | |
| sessionPersistence | `src/api/sessionPersistence.test.ts` | 37 | PASS | W9-DATA persistence |
| sessionActivateHydrate | `src/store/sessionActivateHydrate.test.ts` | 4 | PASS | activate hydrate |

**desktop core subtotal: 98 / 98 pass** (8 files)

### apps/crish-desktop (sidebar optional)

| Suite | Path | Tests | Result | Notes |
|-------|------|------:|--------|-------|
| sessionListUtils | `src/components/sidebar/session-list/sessionListUtils.test.ts` | 5 | PASS | |
| sidebarMeasure | `src/components/sidebar/session-list/sidebarMeasure.test.ts` | 7 | PASS | |
| SidebarContextMenus | `src/components/sidebar/SidebarContextMenus.test.ts` | 3 | PASS | |

**sidebar subtotal: 15 / 15 pass** (3 files)  
**Note:** No `useSidebar*.test.ts`; handlers/contextMenu/resize remain untested as units.

### packages/agent-daemon

| Suite | Path | Tests | Result | Notes |
|-------|------|------:|--------|-------|
| run-control | `src/handlers/run-control.test.ts` | 18 | PASS | cooperative / force / soft inject |

**daemon subtotal: 18 / 18 pass** (1 file)

## Fixes applied

| Issue | Change | Files |
|-------|--------|-------|
| — | none required | — |

## Delta vs prior smoke

| Slice | Files | Tests | Failed |
|-------|------:|------:|-------:|
| W7-2 (Wave 5+6 integration) | 27 | 239 | 0 |
| W8-2 (Wave 7–8 smoke) | 40 | 413 | 0 |
| **W10-INT (this run, core)** | **16** | **197** | **0** |
| W10-INT + optional sidebar | 19 | 212 | 0 |

W10-INT is a **narrower post-W8/W9 residual slice** (soft steer, follow_up, persistence, compositionRoot, run-control) rather than a re-run of the full W8-2 expanded smoke.

## Gate notes

| Surface | Status |
|---------|--------|
| Soft steer / input queue (W8-1) | Covered by `agent-input-queue` + `runtime` / session-loop — **PASS** |
| follow_up queue (W8-3) | Covered by `agent-input-queue` + desktop `useChatStream` / `runControlClient` — **PASS** |
| Persistence (W9-DATA) | `sessionPersistence` + `sessionActivateHydrate` — **PASS** |
| compositionRoot (W9-B3) | `compositionRoot` tests — **PASS** |
| Daemon run-control | `run-control` — **PASS** |
| useSidebar unit tests | **N/A** (no dedicated suite) |

## Recommendation

- No merge blockers from this slice.  
- Optional next: re-run full W8-2 smoke if product lands more W10-5/W10-6 changes; add thin unit tests for `useSidebarHandlers` open-new-draft via compositionRoot if W10-3 still open.
