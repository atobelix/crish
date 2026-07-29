# Wave 7–8 Smoke Results (W8-2)

**Agent:** Tester Agent W8-2  
**Date:** 2026-07-29  
**Scope:** Expanded targeted vitest after Wave 7 hydrate fix + `clientMessageId` + stop UX  
**Policy:** Fix only trivial breakage; report pass/fail counts. No product feature work.

## Summary

| Package | Command slice | Test files | Tests | Failed | Status |
|---------|---------------|------------|------:|-------:|--------|
| `packages/agent-runtime` | hooks, control, agent-input-queue, agent-session-loop, session-loop, provider-response-consumer, tool-executor (+ timeout), compact-lifecycle, health-hook-pack, context-compression-gate | 13 | 115 | 0 | **PASS** |
| `apps/crish-desktop` | invariants, compositionRoot, streamingStore, chat-stream, silentComplete, controlMetrics, emptyShellAssert, sessionEventHydrate, sessionSharedHelpers, sessionActivateHydrate, sessionIndex, binary-tree, ComposerField.stop, useAgentStream.stop, EventRouter.terminal, ptyRegistry, hydrateWorkspaceShell, layoutRestore, messageUserProjection | 25 | 268 | 0 | **PASS** |
| `packages/agent-daemon` | `src/handlers/run-control.test.ts` | 1 | 16 | 0 | **PASS** |
| `packages/shared-types` | `src/a1-contracts.test.ts` | 1 | 14 | 0 | **PASS** |
| **Total** | | **40** | **413** | **0** | **PASS** |

- **Vitest (targeted):** all green — no product fixes required  
- **Trivial breakage fixed:** none  
- **Compared to W7-2 (239 tests):** expanded slice adds tool-executor, provider-response-consumer, daemon run-control, stop UX, hydrate/session index, pty, layout restore, message projection, etc.

## Commands run

Root: `C:\Software\conex`. PowerShell (use `;` not `&&`). Vitest v3.2.7, `--coverage.enabled=false`.  
**Important:** run from each package directory so `src/...` does not cross-match workspace projects.

### agent-runtime

```powershell
Set-Location packages/agent-runtime
npx vitest run src/hooks src/control src/agent-input-queue.test.ts src/agent-session-loop.test.ts src/session-loop src/runtime-components/provider-response-consumer.test.ts src/runtime-components/tool-executor.test.ts src/runtime-components/tool-executor-timeout.test.ts src/runtime-components/context-compression-gate.test.ts --coverage.enabled=false
```

### crish-desktop

```powershell
Set-Location apps/crish-desktop
npx vitest run src/__tests__/invariants src/app/compositionRoot.test.ts src/store/streamingStore.test.ts src/hooks/chat-stream src/api/silentComplete.test.ts src/api/controlMetrics.test.ts src/dev/emptyShellAssert.test.ts src/api/sessionEventHydrate.test.ts src/store/sessionSharedHelpers.test.ts src/store/sessionActivateHydrate.test.ts src/store/sessionIndex.test.ts src/components/binary-tree src/components/chat-composer/ComposerField.stop.test.tsx src/hooks/useAgentStream.stop.test.ts src/api/daemon-chat-bridge/EventRouter.terminal.test.ts src/api/ptyRegistry.test.ts src/app/__tests__/hydrateWorkspaceShell.test.ts src/store/layout-tree/layoutRestorePolicy.test.ts src/api/messageUserProjection.test.ts --coverage.enabled=false
```

### agent-daemon (run-control)

```powershell
Set-Location packages/agent-daemon
npx vitest run src/handlers/run-control.test.ts --coverage.enabled=false
```

### shared-types a1-contracts

```powershell
Set-Location packages/shared-types
npx vitest run src/a1-contracts.test.ts --coverage.enabled=false
```

## Full pass/fail table

### packages/agent-runtime

| Suite | Path | Tests | Result | Notes |
|-------|------|------:|--------|-------|
| lifecycle hooks | `src/hooks/lifecycle-hooks.test.ts` | 9 | PASS | |
| compact lifecycle | `src/hooks/compact-lifecycle.test.ts` | 6 | PASS | |
| health hook pack | `src/hooks/health-hook-pack.test.ts` | 10 | PASS | |
| control bus | `src/control/control-bus.test.ts` | 9 | PASS | L0–L3 |
| control-check | `src/session-loop/control-check.test.ts` | 5 | PASS | |
| session-loop index | `src/session-loop/index.test.ts` | 2 | PASS | |
| session-loop provider-call | `src/session-loop/provider-call.test.ts` | 1 | PASS | |
| agent-input-queue | `src/agent-input-queue.test.ts` | 13 | PASS | |
| agent-session-loop | `src/agent-session-loop.test.ts` | 16 | PASS | L3 mid-stream salvage |
| provider-response-consumer | `src/runtime-components/provider-response-consumer.test.ts` | 9 | PASS | **new vs W7-2** |
| tool-executor | `src/runtime-components/tool-executor.test.ts` | 29 | PASS | **new vs W7-2** |
| tool-executor-timeout | `src/runtime-components/tool-executor-timeout.test.ts` | 1 | PASS | **new vs W7-2** |
| context-compression-gate | `src/runtime-components/context-compression-gate.test.ts` | 5 | PASS | |

**agent-runtime subtotal: 115 / 115 pass** (13 files)

### apps/crish-desktop

| Suite | Path | Tests | Result | Notes |
|-------|------|------:|--------|-------|
| systemInvariants | `src/__tests__/invariants/systemInvariants.test.ts` | 16 | PASS | |
| compositionRoot | `src/app/compositionRoot.test.ts` | 11 | PASS | |
| streamingStore | `src/store/streamingStore.test.ts` | 18 | PASS | |
| chat-stream multimodal | `src/hooks/chat-stream/multimodal.test.ts` | 4 | PASS | |
| useStreamCallbacks | `src/hooks/chat-stream/useStreamCallbacks.test.ts` | 2 | PASS | |
| useStreamCallbacks streamStore | `src/hooks/chat-stream/useStreamCallbacks.streamStore.test.ts` | 8 | PASS | |
| silentComplete | `src/api/silentComplete.test.ts` | 19 | PASS | |
| controlMetrics | `src/api/controlMetrics.test.ts` | 9 | PASS | **new vs W7-2** |
| emptyShellAssert | `src/dev/emptyShellAssert.test.ts` | 7 | PASS | |
| sessionEventHydrate | `src/api/sessionEventHydrate.test.ts` | 23 | PASS | +3 vs W7-2 (20→23) |
| sessionSharedHelpers | `src/store/sessionSharedHelpers.test.ts` | 7 | PASS | |
| sessionActivateHydrate | `src/store/sessionActivateHydrate.test.ts` | 4 | PASS | **new vs W7-2** |
| sessionIndex | `src/store/sessionIndex.test.ts` | 33 | PASS | **new vs W7-2** |
| TreeResizeSash | `src/components/binary-tree/TreeResizeSash.memo.test.tsx` | 6 | PASS | |
| UnitSessionTabStrip subscribe | `src/components/binary-tree/UnitSessionTabStrip.subscribe.test.tsx` | 8 | PASS | |
| UnitSessionTabStrip drag | `src/components/binary-tree/UnitSessionTabStrip.drag.test.tsx` | 3 | PASS | |
| UnitSessionTabStrip a11y | `src/components/binary-tree/UnitSessionTabStrip.a11y.test.tsx` | 4 | PASS | |
| useTopBarDrag sessionDrop | `src/components/binary-tree/useTopBarDrag.sessionDrop.test.ts` | 13 | PASS | |
| ComposerField.stop | `src/components/chat-composer/ComposerField.stop.test.tsx` | 9 | PASS | **stop UX (L2/L3)** |
| useAgentStream.stop | `src/hooks/useAgentStream.stop.test.ts` | 3 | PASS | **stop UX** |
| EventRouter.terminal | `src/api/daemon-chat-bridge/EventRouter.terminal.test.ts` | 4 | PASS | **new vs W7-2** |
| ptyRegistry | `src/api/ptyRegistry.test.ts` | 23 | PASS | **new vs W7-2** |
| hydrateWorkspaceShell | `src/app/__tests__/hydrateWorkspaceShell.test.ts` | 7 | PASS | **Wave 7 hydrate** |
| layoutRestorePolicy | `src/store/layout-tree/layoutRestorePolicy.test.ts` | 8 | PASS | **new vs W7-2** |
| messageUserProjection | `src/api/messageUserProjection.test.ts` | 19 | PASS | **new vs W7-2** |

**crish-desktop subtotal: 268 / 268 pass** (25 files)

### packages/agent-daemon

| Suite | Path | Tests | Result | Notes |
|-------|------|------:|--------|-------|
| run-control | `src/handlers/run-control.test.ts` | 16 | PASS | exists; included |

**agent-daemon subtotal: 16 / 16 pass**

### packages/shared-types

| Suite | Path | Tests | Result | Notes |
|-------|------|------:|--------|-------|
| a1-contracts | `src/a1-contracts.test.ts` | 14 | PASS | +1 vs W7-2 (13→14) |

**shared-types subtotal: 14 / 14 pass**

## Issues found & fixes

| # | Severity | Surface | Issue | Fix | Status |
|---|----------|---------|-------|-----|--------|
| — | — | — | No failures in targeted slice | N/A | **none needed** |

### Non-blocking notes

| Item | Detail |
|------|--------|
| Root workspace deprecation | When run from monorepo root, Vitest warns: workspace file → prefer `test.projects` in root `vitest.config.ts`. Package-local runs do not emit this for agent-runtime/desktop/daemon/shared-types scoped configs. |
| stderr expected | `hydrateWorkspaceShell` logs restore rejection for invalid multi-unit tree fixture (asserted path). |
| stdout expected | `messageUserProjection` debug export dumps empty DTO when localStorage flag enabled in test. |

## Wave 7–8 surface coverage notes

- **Hydrate:** `sessionEventHydrate` (23), `sessionActivateHydrate` (4), `hydrateWorkspaceShell` (7), `layoutRestorePolicy` (8) all green.
- **Stop UX:** `ComposerField.stop` (9) — stop control while processing, Tooltip/aria; `useAgentStream.stop` (3); runtime L2/L3 via control-bus + agent-session-loop.
- **clientMessageId / contracts:** `a1-contracts` (14) green; session index + message projection slices green.
- **Tool / stream pipeline:** `tool-executor` (29+1 timeout), `provider-response-consumer` (9) green (W7-2 residual tsc on tool-executor not exercised as fail in vitest).

## Verdict

| Check | Result |
|-------|--------|
| Targeted vitest agent-runtime | **PASS** 115/115 |
| Targeted vitest crish-desktop | **PASS** 268/268 |
| agent-daemon run-control | **PASS** 16/16 |
| shared-types a1-contracts | **PASS** 14/14 |
| **Grand total** | **PASS 413 / 413** (40 files, 0 failed) |
| Trivial fixes applied | **None** |
| Large features started | **No** |
