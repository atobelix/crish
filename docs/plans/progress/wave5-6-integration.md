# Wave 5+6 Integration Results (W7-2)

**Agent:** Integrator Agent W7-2
**Date:** 2026-07-29
**Scope:** Post Wave 5+6 parallel edits — TypeScript / import / vitest integration on key surfaces
**Policy:** Minimal product changes; fix failures quickly; no large features.

## Summary

| Package | Command slice | Test files | Tests | Failed | Status |
|---------|---------------|------------|------:|-------:|--------|
| `packages/agent-runtime` | hooks, control, session-loop, agent-session-loop, input-queue, context-compression-gate | 10 | 76 | 0 | **PASS** |
| `apps/crish-desktop` | chat-stream, streamingStore, compositionRoot, silentComplete, dev, invariants, sessionEventHydrate, sessionSharedHelpers, binary-tree | 16 | 150 | 0 | **PASS** |
| `packages/shared-types` | `src/a1-contracts.test.ts` | 1 | 13 | 0 | **PASS** |
| **Total** | | **27** | **239** | **0** | **PASS** |

- **Vitest (targeted):** all green after fixes
- **Product / feature work:** none
- **Blockers remaining for full E0 gate:** outside this slice (e.g. residual package-wide `tsc` noise in `tool-executor.test.ts`)

## Commands run

Root: `C:\Software\conex`. PowerShell (use `;` not `&&`). Vitest v3.2.7, `--coverage.enabled=false`.

### agent-runtime

```powershell
Set-Location packages/agent-runtime
npx vitest run src/hooks src/agent-input-queue.test.ts src/control src/session-loop src/agent-session-loop.test.ts src/runtime-components/context-compression-gate.test.ts --coverage.enabled=false
```

### crish-desktop

```powershell
Set-Location apps/crish-desktop
npx vitest run src/hooks/chat-stream src/store/streamingStore.test.ts src/app/compositionRoot.test.ts src/api/silentComplete.test.ts src/dev src/__tests__/invariants src/api/sessionEventHydrate.test.ts src/store/sessionSharedHelpers.test.ts src/components/binary-tree --coverage.enabled=false
```

### shared-types a1-contracts

```powershell
Set-Location packages/shared-types
npx vitest run src/a1-contracts.test.ts --coverage.enabled=false
```

### typecheck (agent-runtime)

```powershell
Set-Location packages/agent-runtime
npx tsc --noEmit
```

## Full pass/fail table

### packages/agent-runtime

| Suite | Path | Tests | Result | Notes |
|-------|------|------:|--------|-------|
| lifecycle hooks | `src/hooks/lifecycle-hooks.test.ts` | 9 | PASS | observe overloads fixed |
| compact lifecycle | `src/hooks/compact-lifecycle.test.ts` | 6 | PASS | W6-8 |
| health hook pack | `src/hooks/health-hook-pack.test.ts` | 10 | PASS | exactOptional isError helper |
| control bus | `src/control/control-bus.test.ts` | 9 | PASS | L0–L3 |
| control-check | `src/session-loop/control-check.test.ts` | 5 | PASS | |
| session-loop index | `src/session-loop/index.test.ts` | 2 | PASS | |
| session-loop provider-call | `src/session-loop/provider-call.test.ts` | 1 | PASS | |
| agent-input-queue | `src/agent-input-queue.test.ts` | 13 | PASS | |
| agent-session-loop | `src/agent-session-loop.test.ts` | 16 | PASS | L3 mid-stream salvage |
| context-compression-gate | `src/runtime-components/context-compression-gate.test.ts` | 5 | PASS | W6-8 gate + lifecycle |

**agent-runtime subtotal: 76 / 76 pass**

### apps/crish-desktop

| Suite | Path | Tests | Result | Notes |
|-------|------|------:|--------|-------|
| chat-stream multimodal | `src/hooks/chat-stream/multimodal.test.ts` | 4 | PASS | |
| useStreamCallbacks | `src/hooks/chat-stream/useStreamCallbacks.test.ts` | 2 | PASS | |
| useStreamCallbacks streamStore | `src/hooks/chat-stream/useStreamCallbacks.streamStore.test.ts` | 8 | PASS | |
| streamingStore | `src/store/streamingStore.test.ts` | 18 | PASS | |
| compositionRoot | `src/app/compositionRoot.test.ts` | 11 | PASS | |
| silentComplete | `src/api/silentComplete.test.ts` | 19 | PASS | |
| emptyShellAssert | `src/dev/emptyShellAssert.test.ts` | 7 | PASS | |
| DevHealthOverlay | `src/dev/DevHealthOverlay.test.ts` | 4 | PASS | |
| systemInvariants | `src/__tests__/invariants/systemInvariants.test.ts` | 16 | PASS | |
| sessionEventHydrate | `src/api/sessionEventHydrate.test.ts` | 20 | PASS | |
| sessionSharedHelpers | `src/store/sessionSharedHelpers.test.ts` | 7 | PASS | |
| TreeResizeSash | `src/components/binary-tree/TreeResizeSash.memo.test.tsx` | 6 | PASS | |
| UnitSessionTabStrip subscribe | `src/components/binary-tree/UnitSessionTabStrip.subscribe.test.tsx` | 8 | PASS | |
| UnitSessionTabStrip drag | `src/components/binary-tree/UnitSessionTabStrip.drag.test.tsx` | 3 | PASS | |
| UnitSessionTabStrip a11y | `src/components/binary-tree/UnitSessionTabStrip.a11y.test.tsx` | 4 | PASS | |
| useTopBarDrag sessionDrop | `src/components/binary-tree/useTopBarDrag.sessionDrop.test.ts` | 13 | PASS | |

**crish-desktop subtotal: 150 / 150 pass**

### packages/shared-types

| Suite | Path | Tests | Result | Notes |
|-------|------|------:|--------|-------|
| a1-contracts | `src/a1-contracts.test.ts` | 13 | PASS | run-control / identity contracts |

## Issues found & fixes

| # | Severity | Surface | Issue | Fix | Status |
|---|----------|---------|-------|-----|--------|
| 1 | **test fail** | `agent-session-loop` L3 | First run: `L3 force_cancel keeps partial assistant text` expected assistant messages after **pre-run** `requestForceCancel`. L3 aborts at stream entry before any tokens → 0 assistants. | Test already aligned to **mid-stream** cancel: mock `pauseAfterIndex` + `requestForceCancel` on first `message-delta` so partial salvage has content. Product L3 salvage path unchanged. | **PASS** |
| 2 | tsc | `lifecycle-hooks.ts` | Unused `ContextCompact*` value imports; `observe` union signature collapsed payload to implicit `any` for handlers. | Drop unused imports; overload `observe('*')` vs `observe<T>(type, handler)`. | fixed |
| 3 | tsc | `context-compression-gate.ts` | `exactOptionalPropertyTypes`: `trigger` / `tokensBefore` as `T \| undefined` assigned into optional props. | Conditionally spread only when defined. | fixed |
| 4 | tsc | `health-hook-pack.test.ts` | `isError: opts?.isError` produced `boolean \| undefined` for optional field. | Conditional spread for `isError`. | fixed |
| 5 | tsc | `context-compression-gate.test.ts` | `onEventSpy()` called with 0 args while typed 1–2. | Call `onEventSpy('compression-end')`. | fixed |

### Residual (out of targeted slice)

| File | Issue | Action |
|------|-------|--------|
| `src/runtime-components/tool-executor.test.ts:272` | `exactOptionalPropertyTypes` on `text: string \| undefined` | Not in W7-2 command list; left for owner |

## Integration notes (Wave 5+6 surfaces)

- **L2 vs L3 control timing**
  - L2 `cooperative_stop`: applied at post-stream safe point → assistant message already committed (continue-after-stop keeps text).
  - L3 `force_cancel`: can interrupt stream immediately; partial salvage only when consumer already accumulated blocks (`ProviderResponseConsumer.finishAfterAbort` + `commitAssistantMessage(..., { aborted: true })`).
  - Pre-run L3 with no tokens → `endReason=aborted`, no assistant message (by design).

- **Lifecycle / compact**
  - `context.compact.start|end` observe-only; gate emits when `lifecycleHooks` + `sessionId` set; compress path works without registry.

- **Desktop**
  - No import or vitest breakage on chat-stream / streamingStore / compositionRoot / binary-tree / invariants slices.

## Fixes applied (file list)

| File | Change |
|------|--------|
| `packages/agent-runtime/src/hooks/lifecycle-hooks.ts` | observe overloads; unused import cleanup |
| `packages/agent-runtime/src/runtime-components/context-compression-gate.ts` | exactOptional-safe aborted end payload |
| `packages/agent-runtime/src/hooks/health-hook-pack.test.ts` | exactOptional-safe `toolPost` helper |
| `packages/agent-runtime/src/runtime-components/context-compression-gate.test.ts` | onEventSpy arity |

## Verdict

| Check | Result |
|-------|--------|
| Targeted vitest agent-runtime | **PASS** 76/76 |
| Targeted vitest crish-desktop | **PASS** 150/150 |
| shared-types a1-contracts | **PASS** 13/13 |
| Wave integration blockers | **None** on assigned surfaces |
| Large features started | **No** |
