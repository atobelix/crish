# E0-1 gate-invariants — I-* runnable suite

**Agent:** Implementer Agent W6-3  
**Date:** 2026-07-29  
**Scope:** Master plan §14.1 global invariants as focused vitest (pure helpers / store fixtures; no App mount)  
**Ownership:** `apps/crish-desktop/src/__tests__/invariants/**`

## Invariants covered

| ID | Statement | Assertion surface |
|----|-----------|-------------------|
| **I-DRAFT** | draft not in `sessions[]` | `prepareSessionsForUi` strips `__pending_draft__`; `findEmptyShellViolations` → `i_draft_in_sessions`; `isPendingDraft` |
| **I-PROJ** | UserView must not write back ModelView | `projectSessionMessagesToUserView` / `projectEngineBlocksToUserView` leave source unchanged; DTO mutation isolated |
| **I-SHELL** | 1 session ≤ 1 chat leaf | `findDuplicateSessionChatLeaves` / `dedupeDuplicateSessionChatLeaves` / `validateRestorableLayoutTree` |
| **I-PTY** | 1 session ≤ 1 live ptyId | pure `bindSessionPty` Map semantics + multi-session isolation |
| **(optional)** | message upsert by id idempotent | `upsertMessageById` → updated vs appended; `listDuplicateMessageIds` empty |

Related (already covered elsewhere, not duplicated heavily here):

- Domain suites: `draftSession.test.ts`, `emptyShellAssert.test.ts`, `messageUserProjection.test.ts`, `conversationUnit.test.ts`, `layoutRestorePolicy.test.ts`, `ptyRegistry.test.ts`, `sessionTitle.test.ts` (I-DRAFT prepare path)
- Chat UI heuristics: `src/__tests__/chatInvariants.test.ts` (empty kind / stream UX — not master-plan I-*)

## How to run

From monorepo root (`C:\Software\conex`):

```bash
npx vitest run apps/crish-desktop/src/__tests__/invariants --coverage.enabled=false
```

Single file:

```bash
npx vitest run apps/crish-desktop/src/__tests__/invariants/systemInvariants.test.ts --coverage.enabled=false
```

From `apps/crish-desktop` (if cwd is package):

```bash
npx vitest run src/__tests__/invariants --coverage.enabled=false
```

## Suite path

| File | Role |
|------|------|
| [`apps/crish-desktop/src/__tests__/invariants/systemInvariants.test.ts`](../../../apps/crish-desktop/src/__tests__/invariants/systemInvariants.test.ts) | E0-1 gate: I-DRAFT, I-PROJ, I-SHELL, I-PTY, message upsert |

## Results (W6-3)

| Suite | Tests | Result |
|-------|------:|--------|
| `systemInvariants.test.ts` | 16 | **PASS** (see agent run log) |

Command used:

```text
npx vitest run apps/crish-desktop/src/__tests__/invariants/systemInvariants.test.ts --coverage.enabled=false
```

## Policy

- Prefer pure functions + tiny fixtures over full store/App mount.
- Do not edit product code unless a tiny export is required (this wave: imports only).
- Avoid ownership of W5-1 chat-stream, W5-2 compositionRoot, W5-6 App.tsx.
