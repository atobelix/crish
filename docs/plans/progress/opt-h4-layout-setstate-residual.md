# OPT-H4 — layout.setState residual in stream paths

| Field | Value |
|-------|-------|
| Agent | OPT-H4 |
| Date | 2026-07-29 |
| Choice | **B** — document residual; **no** `layout.patchState` / god setState facade |
| Kill | #6 (getState scatter / compositionRoot) — residual intentional, not a gap |
| Related | OPT-F4 marked “layout.setState residual intentional”; OPT-G3 useAgentStream → root |

## Decision: B (not A)

**A** would add `layout.patchState(partial | recipe)` on `LayoutFacade` and migrate 1–2 call sites.

Rejected because:

1. Residual call sites are **immer recipes** (`useLayoutStore.setState((state) => { …mutate nested… })`), not simple partial merges.
2. A generic `patchState` on the facade is a **god setState** re-export — anti-overengineering; LayoutFacade stays **named command methods** only.
3. Migrating only 1–2 sites would not remove the rest; full rewrite of immer patches is **out of scope** (task: do not full rewrite).
4. Prefer thin facade + explicit residual over a second write path that looks “clean” but hides store authority.

## Split of authority (current truth)

| Path | API | Examples |
|------|-----|----------|
| **Command / chrome** | `getCompositionRoot().layout.*` named methods + `getState()` | `setAppSettings`, `setSidebarCollapsed`, `getSessions`, stream **reads** (`tokenUsage`, `setSessionMessageStatus` via getState actions) |
| **Stream hot nested mutates** | `useLayoutStore.setState(recipe)` (immer) | runId on session, subagent messages, timeline normalize, stop tool batch, agent panel `buildPatchAsst` / `finalizeInFlight` |

React render still uses `useLayoutStore(selector)` — never subscribe via the facade.

## Residual inventory (product TS)

### `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts`

| Site (approx) | Recipe purpose |
|---------------|----------------|
| `onRunMeta` | `sessionsById[sid].engineLastRunId = runId` |
| `onSubagentEvent` | agent.messages ← applySubagentEventToMessages |
| `onSubagentEnded` | agent status/summary/endedAt + parent tool output |
| complete path | normalizeAssistantTimeline → msg.blocks / toolCalls |
| stop path | batch terminal tool status/output |

**Already on root:** `getCompositionRoot().layout.getState()` for session actions / tokenUsage / fail-closed queue status (OPT-F4).

### `apps/crish-desktop/src/hooks/useAgentStream.ts`

| Site | Recipe purpose |
|------|----------------|
| `buildPatchAsst` | nested agent assistant message mutator for stream chunks |
| `finalizeInFlight` | complete processing msgs + kill in-flight tool rows |

**Already on root:** `getCompositionRoot().session.getState()` for subagent runId read.

### Out of residual scope

- Test helpers that call `useLayoutStore.setState` to seed state.
- Store actions that internally use immer (not stream-path direct setState).

## LayoutFacade policy

`apps/crish-desktop/src/app/compositionRoot.ts` — **no** `setState` / `patchState`.

Add named methods only when a **stable command** appears (e.g. pin/archive already on session facade). Do not wrap arbitrary immer recipes.

## Code comments

- `compositionRoot.ts` LayoutFacade JSDoc — no setState/patchState (OPT-H4)
- `useStreamCallbacks.ts` — short OPT-H4 notes on residual setState sites
- `useAgentStream.ts` — short OPT-H4 notes on `buildPatchAsst` / `finalizeInFlight`

## Verify

```text
rg "useLayoutStore\.setState" apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts apps/crish-desktop/src/hooks/useAgentStream.ts
rg "patchState" apps/crish-desktop/src/app/compositionRoot.ts
```

Expect: residual setState only with OPT-H4 comments; **no** `patchState` on LayoutFacade.

## Non-goals

- Rewriting immer patches into discrete store actions this wave
- Forcing stream hot path through compositionRoot writes
- Expanding LayoutFacade into a full zustand mirror
