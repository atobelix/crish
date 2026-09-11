# E0-2 typecheck gate — desktop + core packages

**Agent:** Gate Agent W7-4
**Date:** 2026-07-29
**Scope:** `apps/crish-desktop`, `packages/agent-runtime`, `packages/agent-daemon`, `packages/agent-orchestrator`, `packages/shared-types`
**Ownership:** fix trivial Wave 4–6 TS only; report hard / pre-existing debt separately

## Commands used

`pnpm` is not on PATH in this environment; used local `npx tsc` (same as monorepo `package.json` check scripts).

```bash
npx tsc -p packages/shared-types --noEmit --pretty false
npx tsc -p packages/agent-runtime --noEmit --pretty false
npx tsc -p packages/agent-daemon --noEmit --pretty false
npx tsc -p packages/agent-orchestrator --noEmit --pretty false
npx tsc -p apps/crish-desktop --noEmit --pretty false
```

Equivalent root scripts (when wired): `check:runtime`, `check:daemon`, `check:orchestrator`, `check:desktop` / `typecheck`.

## Error counts (before → after)

| Package | Before (initial gate scan) | After (post-fix) | Notes |
|---------|---------------------------:|------------------:|-------|
| `packages/shared-types` | 0 | **0** | Clean |
| `packages/agent-runtime` | 28 | **0** | 1 durable fix applied (see below) |
| `packages/agent-daemon` | 8* | **0** | *cascade from agent-runtime sources via project refs |
| `packages/agent-orchestrator` | 8* | **0** | *same cascade |
| `apps/crish-desktop` | 0 | **0** | Clean |

\* Daemon/orchestrator initial errors were all in `packages/agent-runtime/src/**` files pulled via composite references, not local daemon/orchestrator sources.

### Initial scan breakdown (`agent-runtime`, 28)

| Area | Count | Codes | Classification |
|------|------:|-------|----------------|
| `hooks/health-hook-pack.ts` | 5 | TS7006 implicit `any` on observe `p` | Wave D2-2 / W7-1 health pack |
| `hooks/lifecycle-hooks.ts` | 2 | TS6196 unused type imports | Wave B2 / W6-8 compact re-exports |
| `runtime-components/context-compression-gate.ts` | 1 | TS2379 `exactOptionalPropertyTypes` | Wave W6-8 compact emit |
| `hooks/health-hook-pack.test.ts` | 6 | TS2379 `isError` EOPT | Wave tests |
| `hooks/compact-lifecycle.test.ts` | 3 | TS7006 | Wave W6-8 tests |
| `hooks/lifecycle-hooks.test.ts` | 1 | TS7006 | Wave tests |
| `agent-session-loop.test.ts` | 4 | TS7006 | Wave tests |
| `runtime-components/context-compression-gate.test.ts` | 5 | TS7006 + TS2554 | Wave tests |
| `runtime-components/tool-executor.test.ts` | 1 | TS2379 `text` EOPT | Wave lifecycle middleware test |

After clearing `node_modules/.cache/agent-runtime.tsbuildinfo` and re-running, **only** `tool-executor.test.ts` remained. Other initial errors were not reproducible against current tree (already fixed in-source or composite/cache noise). No code was mass-suppressed with `any`.

## Fix applied (this gate)

**File:** `packages/agent-runtime/src/runtime-components/tool-executor.test.ts`

**Issue:** With `exactOptionalPropertyTypes`, pushing `{ text: p.output?.text }` where `text` is `string | undefined` into `Array<{ toolName: string; text?: string }>` is illegal (optional ≠ `| undefined`).

**Change:** Narrow before push:

```ts
const text = p.output?.text;
posts.push(
  text !== undefined ? { toolName: p.toolName, text } : { toolName: p.toolName },
);
```

## Policy compliance

| Rule | Status |
|------|--------|
| Fix only Wave 4–6 / our-touch trivial TS | Yes (single EOPT test fix) |
| No mass-suppress with `any` | Yes |
| Do not invent large refactors | Yes |
| Hard / unrepro / pre-existing debt listed | Yes (none remaining in gate set) |

## Remaining debt

| Item | Severity | Owner suggestion |
|------|----------|------------------|
| None in the five gate packages after re-check | — | — |

### Notes for follow-ups (not blockers for E0-2)

1. **Composite + incremental:** Prefer deleting the package `tsBuildInfoFile` (under `node_modules/.cache/`) when counts look inflated; cascade errors into daemon/orchestrator can mirror runtime source errors.
2. **`exactOptionalPropertyTypes`:** Prefer conditional spreads / narrowed locals over `prop: maybeUndefined` for optional fields (production + tests).
3. **`LifecycleHookRegistry.observe` overloads:** Implementation signature uses `(payload: never)`; call-site inference is sensitive to circular types (`lifecycle-hooks` ↔ `compact-lifecycle`). If TS7006 on `p` reappears, annotate handlers with payload types or break the cycle.
4. **Out of scope:** Other monorepo packages (e.g. `decision-engine`, `shared-utils`, `agent-provider-http` empty `include`) not part of this gate.

## Final gate result

| Package | Exit | Errors |
|---------|-----:|-------:|
| `shared-types` | 0 | 0 |
| `agent-runtime` | 0 | 0 |
| `agent-daemon` | 0 | 0 |
| `agent-orchestrator` | 0 | 0 |
| `crish-desktop` | 0 | 0 |

**E0-2 (desktop + core):** **PASS**
