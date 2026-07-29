# Wave 4 Ownership Surfaces — Smoke / Regression Results (W5-8)

**Agent:** Tester Agent W5-8  
**Date:** 2026-07-29  
**Scope:** Targeted vitest regression for Wave 4 ownership surfaces  
**Policy:** Test fixes only; no feature work. Large product failures documented, not redesigned.

## Summary

| Package | Test files | Tests | Failed | Status |
|---------|------------|-------|--------|--------|
| `packages/agent-runtime` | 7 | 57 | 0 | **PASS** |
| `apps/crish-desktop` | 15 | 245 | 0 | **PASS** |
| **Total** | **22** | **302** | **0** | **PASS** |

- **Fixes applied:** none (no env/import/jsdom breakage discovered)
- **Product bugs:** none observed in this slice
- **Blockers for E0 full gate:** none from this Wave 4 ownership subset (see below)

## Commands run

Root workspace (`C:\Software\conex`), Vitest v3.2.7, `--coverage.enabled=false`.

### agent-runtime

```text
npx vitest run \
  src/hooks/lifecycle-hooks.test.ts \
  src/runtime-components/tool-executor.test.ts \
  src/runtime-components/tool-executor-timeout.test.ts \
  src/agent-session-loop.test.ts \
  --coverage.enabled=false
```

```text
npx vitest run src/session-loop --coverage.enabled=false
```

### crish-desktop

```text
npx vitest run \
  src/components/binary-tree/UnitSessionTabStrip.subscribe.test.tsx \
  src/components/binary-tree/UnitSessionTabStrip.drag.test.tsx \
  src/components/binary-tree/TreeResizeSash.memo.test.tsx \
  src/app/compositionRoot.test.ts \
  src/api/ptyRegistry.test.ts \
  src/api/controlMetrics.test.ts \
  src/api/messageUserProjection.test.ts \
  src/dev/emptyShellAssert.test.ts \
  src/app/__tests__/hydrateWorkspaceShell.test.ts \
  src/store/layout-tree/layoutRestorePolicy.test.ts \
  src/store/layout-tree/layoutTreeStore.test.ts \
  src/api/markdownRenderAsync.test.ts \
  src/api/markdownRender.lists.test.ts \
  src/store/sessionActions.test.ts \
  src/store/draftSession.test.ts \
  --coverage.enabled=false
```

## Full pass/fail table

### packages/agent-runtime

| Suite | Path | Tests | Result | Notes |
|-------|------|------:|--------|-------|
| lifecycle hooks | `src/hooks/lifecycle-hooks.test.ts` | 9 | PASS | |
| tool-executor | `src/runtime-components/tool-executor.test.ts` | 29 | PASS | |
| tool-executor timeout | `src/runtime-components/tool-executor-timeout.test.ts` | 1 | PASS | included as tool-executor\* |
| agent-session-loop | `src/agent-session-loop.test.ts` | 11 | PASS | |
| session-loop index | `src/session-loop/index.test.ts` | 2 | PASS | |
| session-loop provider-call | `src/session-loop/provider-call.test.ts` | 1 | PASS | |
| session-loop control-check | `src/session-loop/control-check.test.ts` | 4 | PASS | |

**agent-runtime subtotal: 57 / 57 pass**

### apps/crish-desktop

| Suite | Path | Tests | Result | Notes |
|-------|------|------:|--------|-------|
| UnitSessionTabStrip subscribe | `src/components/binary-tree/UnitSessionTabStrip.subscribe.test.tsx` | 8 | PASS | narrow re-render |
| UnitSessionTabStrip drag | `src/components/binary-tree/UnitSessionTabStrip.drag.test.tsx` | 3 | PASS | D5 drag wiring |
| TreeResizeSash memo | `src/components/binary-tree/TreeResizeSash.memo.test.tsx` | 6 | PASS | React.memo |
| compositionRoot | `src/app/compositionRoot.test.ts` | 6 | PASS | B3 + pty killAll |
| ptyRegistry | `src/api/ptyRegistry.test.ts` | 23 | PASS | |
| controlMetrics | `src/api/controlMetrics.test.ts` | 9 | PASS | D2 lite |
| messageUserProjection | `src/api/messageUserProjection.test.ts` | 19 | PASS | stdout debug noise only |
| emptyShellAssert | `src/dev/emptyShellAssert.test.ts` | 7 | PASS | D2-4 |
| hydrateWorkspaceShell | `src/app/__tests__/hydrateWorkspaceShell.test.ts` | 7 | PASS | expected stderr on reject path |
| layoutRestorePolicy | `src/store/layout-tree/layoutRestorePolicy.test.ts` | 8 | PASS | W4-5 restore |
| layoutTreeStore | `src/store/layout-tree/layoutTreeStore.test.ts` | 40 | PASS | store + restore paths |
| markdownRenderAsync | `src/api/markdownRenderAsync.test.ts` | 10 | PASS | Stream C subset |
| markdownRender lists | `src/api/markdownRender.lists.test.ts` | 60 | PASS | lists subset |
| sessionActions | `src/store/sessionActions.test.ts` | 37 | PASS | create/prune/delete |
| draftSession | `src/store/draftSession.test.ts` | 2 | PASS | shared-types align |

**crish-desktop subtotal: 245 / 245 pass**

## Observed non-failures

These are expected harness / intentional path noise, not failures:

1. **messageUserProjection** — `stdout` from `isUserViewDebugEnabled / debugExportUserView` localStorage flag path.
2. **hydrateWorkspaceShell** — `stderr` `[hydrateWorkspaceShell] restore rejected: multi-unit-unbound-chat → clean single chat` on invalid multi-unit restore fallback test.
3. Root Vitest deprecation warning: workspace file → prefer `test.projects` in root `vitest.config.ts` (infra hygiene, not a test fail).

## Fixes applied

None. No jsdom env, missing import path, or deleted-module breakage in this slice.

## Blockers for E0 full gate

From **this** Wave 4 ownership smoke only:

| Item | Severity | Blocks E0? |
|------|----------|------------|
| Wave 4 ownership unit suites | — | **No** — all green |
| Full monorepo vitest matrix | unknown | Not run in W5-8 |
| Integration / e2e / Playwright | unknown | Not run in W5-8 |
| Coverage gates | n/a | Disabled for smoke (`--coverage.enabled=false`) |
| Vitest workspace deprecation | low | No — warning only |

**E0 note:** This agent only exercised the listed Wave 4 ownership surfaces. A full E0 gate still needs the broader unit + integration + e2e matrices outside this charter; no product failure was found that would block those runs from the ownership subset.

## Ownership / out of scope

- Test fixes only (none required)
- Artifact: `docs/plans/progress/wave4-smoke-results.md` (this file)
- No feature work, no product rewrites
)
