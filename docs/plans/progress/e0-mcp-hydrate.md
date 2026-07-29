# E0-MCP activate hydrate — dual-view agreement (W9-MCP-3)

**Agent:** MCP Verifier + light fixer W9-MCP-3  
**Date:** 2026-07-29  
**App:** Crish 0.1.0 @ `http://localhost:5174/` (tauri-mcp)  
**Scope:** After selecting a real session, `sessions[]` and `sessionsById[id]` must agree on messages (same object). LocalStorage bodies often `[]` — daemon hydrate on activate.

---

## Verdict: **PASS** (activate hydrate dual-view) + **fork write-path fixed**

| Check | Result |
|-------|--------|
| Activate real titled session → both views have messages | **PASS** |
| `sessions[i] === sessionsById[id]` (same ref) | **PASS** |
| No list/map length fork after settle | **PASS** |
| Pre-fix fork via `addMessage` → map-only write | **FAIL observed → fixed** |
| Empty local body + daemon down for some ids | **SKIP** (not fork; no body) |

---

## Environment

| Item | Value |
|------|-------|
| Tooling | tauri-mcp `execute_js`, `app_bridge` (`open_session` / `shell_snapshot`), `manage_storage`, `query_logs`, `click` |
| Store facades | `__CRISH_SESSION_STORE__` / `useLayoutStore` |
| Sessions present | 19 (later 20) real titles — not mock A/B/C |
| Product activate path | `openOrFocusSession` → `setActiveSessionId` → `needsEngineMessageHydrate` → `hydrateSessionMessagesFromDaemon` |

**UI click note:** Synthetic tauri-mcp click on sidebar `[role=treeitem]` did **not** reliably update store (active stayed `__pending_draft__`). Product-equivalent `app_bridge.open_session` / `setActiveSessionId` used for activate (same as shell sidebar handler → `openOrFocusSession`).

---

## Baseline (before activate)

All listed sessions: titles non-empty, `messages.length === 0` on **both** views, `sameRef: true`.

| Flag | Count (sample) |
|------|----------------|
| `needHydrate` (`!hydratedFromEngine` && empty msgs) | 12 |
| Already `hydratedFromEngine` + empty | 7 (no re-fetch by design) |
| localStorage `crish_session_body_v1:*` | Many keys are `[]`; after successful hydrate some filled (e.g. 23 / 14 / 5) |

Empty dual-view before activate is **expected lazy shell**, not a fork.

---

## Activate hydrate observation

### Primary target

| Field | Value |
|-------|-------|
| Session | `sess-1784120507760` |
| Title | 你好啊。分析一下当前的代码仓库… |
| Activate | `app_bridge.open_session` / `setActiveSessionId` |
| Wait | ~1.5–3s |

### After hydrate

```
activeSessionId: sess-1784120507760
sessions[].messages.length:     23
sessionsById[id].messages.length: 23
sameRef: true
hydratedFromEngine: true
engineCursor: 517
```

Sample msgs present on **both** views (`user_05650b5c-…`, assistant replies, etc.).

### Secondary activates (same run)

| Session | After | sameRef |
|---------|-------|---------|
| `sess-1784141628869` (你好啊) | 14 msgs | true (after heal) |
| `sess-1784095981934` | 5 msgs | true |
| `sess-1784096051126` | still 0 | true (see SKIP) |

---

## Fork bug (clear) — observed & fixed

### Symptom

After a prior MCP probe write, `sess-1784141628869`:

| View | messages.length | sameRef |
|------|-----------------|---------|
| `sessions[]` | 14 | |
| `sessionsById` | 15 | **false** |
| byId-only id | `mcp-probe-processing-w9b` | |

Stable across 4 samples — not a mid-hydrate race.

### Root cause

1. **Write path used `getSessionById`** in `sessionMessageActions` / agent / some CRUD — mutates via `sessionsById` first.
2. Under immer, map-only mutate **forks** map value; `sessions[]` keeps old object → UI (byId) sees probe, list view empty/stale.
3. **`getSessionForWrite` used `indexOf(hit)`** to detect “same object still in array”. Under immer drafts, `sessionsById[id]` and `sessions[i]` are **different proxies for the same base**, so `indexOf` is always `-1` → unconditional rebind dirtied no-op updates (broke short-circuit tests).

### Fix (this agent)

| File | Change |
|------|--------|
| `store/sessionIndex.ts` | `getSessionForWrite` always takes `sessions[]` element; rebind only when `original()` bases differ; add `rebindSessionById` after real writes |
| `store/sessionMessageActions.ts` | writes via `getSessionForWrite` + `rebindSessionById` |
| `store/sessionAgentActions.ts` | same |
| `store/sessionSharedHelpers.ts` | `getSessionMessage` (write helper) uses `getSessionForWrite` |
| `store/sessionCrudActions.ts` | rename / patch / clearSessionMessages write path |
| `store/sessionOrderingActions.ts` | archive / unarchive write path |

### Post-fix live probe

```
addMessage probe → arr=24, byId=24, sameRef=true, hasArr=true, hasById=true
forks: []
```

### Unit tests

```
npx vitest run apps/crish-desktop/src/store/sessionActivateHydrate.test.ts \
  apps/crish-desktop/src/store/sessionIndex.test.ts \
  apps/crish-desktop/src/store/sessionActions.test.ts --coverage.enabled=false
→ 75 passed (including activate dual-view + no-op short-circuit)
```

---

## Daemon / empty body (SKIP cases)

| Observation | Notes |
|-------------|--------|
| localStorage many `crish_session_body_v1:*` = `[]` | Matches plan note |
| After successful daemon hydrate | LS filled for those ids (23 / 14 / 5) |
| Logs | Repeated `[DesktopDaemonClient] Sidecar restart timed out after 3s polling`; occasional IPC `Failed to fetch` |
| `sess-1784096051126` | title set, msgs still 0, no fork (`sameRef=true`) — daemon empty/fail or not yet marked `hydratedFromEngine` |

**SKIP** when both daemon and local body empty: dual-view still agrees (both `[]`). Not counted as FAIL.

---

## Final numeric snapshot

```
target: sess-1784120507760
  arrMsgLen: 23
  byIdMsgLen: 23
  sameRef: true
  hydratedFromEngine: true
  engineCursor: 517

probe addMessage (post-fix):
  arr/byId: 24/24 sameRef true

forks after settle: []
```

---

## Related docs

- [`e0-mcp-journey.md`](./e0-mcp-journey.md) — earlier mid-hydrate 14/15 sameRef=false note; final journey open of「你好啊」was 14/14
- Activate unit: `apps/crish-desktop/src/store/sessionActivateHydrate.test.ts`
- Write helper: `getSessionForWrite` / `rebindSessionById` in `apps/crish-desktop/src/store/sessionIndex.ts`
