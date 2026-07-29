# Session body empty gap — analysis & fix

**Agent:** Explorer W9-DATA  
**Date:** 2026-07-29  
**Scope:** Why MCP sees `crish_session_body_v1:*` = `[]` while session index has titles; dual path (local body vs daemon events); offline risk.  
**Related:** [`e0-mcp-journey.md`](./e0-mcp-journey.md) (observed `messages.length === 0` on listed sessions)

---

## Verdict

| Question | Answer |
|----------|--------|
| Are empty LS bodies always a bug? | **No** — lazy remote shells intentionally ship `messages: []` until activate. |
| Is dual persistence intentional? | **Yes (Stream D)** — index/meta in LS; **body/agents primary in SQLite**; daemon event store is source of truth for engine-side history. |
| Was there a real product gap? | **Yes** — boot seed reads **LS-only** bodies; when SQLite had content but LS was `[]`/stale, Rust hydrate was **skipped**, and debounced persist could **wipe** SQLite with empty arrays. |
| Messages only in daemon, never mirrored? | **Partial** — local chat + post-hydrate persist **do** mirror into SQLite (and now non-empty LS). Unopened remote shells stay empty until activate + hydrate + persist. |

---

## Architecture (three layers)

```
┌─────────────────────┐
│  Zustand sessions[] │  UI truth while running
└──────────┬──────────┘
           │ persistAllSessions (350ms debounce) / beforeunload sync
           ▼
┌─────────────────────┐     fallback if invoke missing
│  SQLite (conex-db)  │◄────────────────────────────┐
│  save/load_session_ │                             │
│  body               │                             │
└─────────────────────┘                             │
           ▲                                        │
           │ hydrateSessionsFromRust (boot)         │
           │                                        │
┌─────────────────────┐     seedSessions (sync)     │
│ localStorage        │─────────────────────────────┘
│ index  = truth meta │  crish_session_index_v1
│ body   = fallback / │  crish_session_body_v1:<id>
│          mirror     │
└─────────────────────┘

┌─────────────────────┐
│  Daemon event store │  list-sessions → shell titles only
│  read-session-events│  activate → project → merge into store
└─────────────────────┘
```

### When bodies are written

| Trigger | Path | What is written |
|---------|------|-----------------|
| Store domain change (`sessions` / `activeSessionId` / `folderOrder`) | `initStorePersistence` → 350ms → `persistAllSessions` → `persistAllSessionsRust` | Index → LS; body → SQLite (non-empty only after fix); agents → SQLite |
| Stream / chat upserts | Same store subscribe | After message lands in `sessions[]`, debounce writes body |
| `setActiveSessionId` + empty body | `hydrateSessionMessagesFromDaemon` (`read-session-events`) | In-memory merge; then subscribe persists |
| `beforeunload` | `persistAllSessionsSync` → LS only | Non-empty bodies mirrored to LS (after fix) |
| Boot restore | `hydrateSessionsFromRust` | Prefer SQLite body; index LS-first |

**Not** a separate “stream complete” writer: stream complete only updates Zustand; persistence is the domain subscription.

### Daemon list-sessions vs event hydrate

| API | Role |
|-----|------|
| `list-sessions` → `sessions-listed` | Metadata shells: id, title, cwd, timestamps. **No messages.** |
| `mergeDaemonSessions` | Local messages never overwritten. New remote rows inserted **only** with real non-default titles and `messages: []`. |
| `setActiveSessionId` + `needsEngineMessageHydrate` | If `!hydratedFromEngine && messages empty` → `read-session-events` → `projectEventsToMessages` → merge by id. |
| Documented intentional | `sessionDaemonSync.ts` header; `sessionSharedHelpers.needsEngineMessageHydrate` |

MCP seeing titles + `messages.length === 0` for **never activated** remote shells is **expected lazy state**, not silent message loss.

---

## Why MCP saw many `crish_session_body_v1:*` = `[]`

1. **Lazy shells** — daemon merge inserts titled sessions with empty messages; index persists `messageCount: 0`.
2. **Stream D no dual-write (pre-fix)** — when `save_session_body` invoke succeeded, **LS body was not updated**. LS keys often stayed missing or stale `[]` from older sync/beforeunload.
3. **Boot seed gap (real bug)** — `seedSessions()` → `hydrateSessionsFromDisk()` reads **LS only**. If index exists with empty bodies, store starts non-empty → old `initStorePersistence` **returned early** and never applied SQLite bodies.
4. **Wipe race (real bug)** — empty in-memory shells + 350ms `persistAllSessions` called Rust `save_session_body` (delete-all + insert) → **erased SQLite history**.

---

## Offline / empty-chat risk

| Scenario | Offline open result |
|----------|---------------------|
| User chatted this client; persist completed; SQLite OK | Messages available after boot (after fix: also filled from SQLite even if LS empty) |
| Remote shell never activated | Empty chat offline — **intentional** until first online hydrate |
| Activated + hydrated but crash before debounce persist | May lose last turn unless daemon still has events (online recovery) |
| Pre-fix: LS empty seed + wipe race | **Empty chat even with SQLite history** — fixed |

---

## Fix applied (minimal, PR-sized)

**No dual-persistence redesign.** Small surgical changes:

### 1. `store-persistence.ts` — boot body fill

- If store empty → full SQLite restore (unchanged).
- If store already seeded from LS → **fill empty local `messages` from SQLite** for matching ids (never overwrite non-empty local).
- Always re-`setActiveSessionId(active)` after restore path so engine lazy hydrate still runs for remaining empty actives.

### 2. `sessionRustDb.ts` — stop empty body wipe + LS mirror for non-empty

- `persistAllSessionsRust` / local fallback / beforeunload sync: **skip `saveSessionBody` when `messages.length === 0`** (do not delete-then-insert empty over existing SQLite/LS).
- On successful SQLite `saveSessionBody` with **non-empty** messages: also mirror to LS for seed + MCP observability.
- Empty arrays still not written to LS on success path (reduces false “[]” noise).

### Files touched

- `apps/crish-desktop/src/store/layout-helpers/store-persistence.ts`
- `apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts`
- this doc

---

## Intentional vs gap (summary)

| Behavior | Classification |
|----------|----------------|
| Remote list shells with `messages: []` until activate | **Intentional lazy** |
| Bodies primary in SQLite; index in LS | **Intentional Stream D** |
| Daemon events = engine history truth | **Intentional** |
| Skip SQLite restore when LS seed non-empty | **Bug (fixed)** |
| Persist empty body wiping SQLite | **Bug (fixed)** |
| Unopened remote history offline | **Product limit** (acceptable; optional future: background hydrate) |

---

## Follow-ups (out of scope)

1. Background hydrate of last N titled sessions (not only active) for better offline.
2. After engine hydrate success, force immediate `persistAllSessions` (not only 350ms debounce) to shrink crash window.
3. Unit test: seed empty LS + SQLite non-empty → post-init messages filled; empty persist does not call save with `[]`.
4. MCP probe should prefer `load_session_body` invoke / store `sessions[]` after activate, not LS alone.
5. Full redesign of dual persistence — **do not** without a separate plan.

---

## How to verify

```text
1. With known SQLite bodies and LS body keys = [] (or missing):
   restart app → open session → messages present without re-chat.
2. MCP: after a completed turn, crish_session_body_v1:<id> is non-empty array
   (or invoke load_session_body returns rows).
3. Never-opened remote title in sidebar: body may remain empty until click — OK.
4. Offline kill daemon: previously opened/persisted sessions still show messages.
```
