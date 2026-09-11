# ADR: Multi-unit layout cold-start restore

| Field | Value |
|-------|-------|
| Status | Accepted |
| Date | 2026-07-29 |
| Scope | `apps/crish-desktop` layout tree + workspace shell |
| Related | `docs/plans/2026-07-shell-residual-optimization.md` **D-D / S3** |

---

## 1. Context

The layout tree (`crish-layout-tree-v1`) always **persists** the live multi-unit tree while the app runs. Cold start previously risked rehydrating a broken multi-unit topology (unbound chats, duplicate session bindings, orphan tool leaves) or flashing multi-leaf chrome before the shell was ready.

Product decision **D-D**: prefer a **safe single-chat clean default**; full multi-unit restore is **opt-in**.

## 2. Decision

| Mode | Flag | Behavior |
|------|------|----------|
| **Clean (default)** | `ui.restoreLastWorkspace` = **false** | Ignore multi-unit rehydrate; `resetTree('chat')` + single draft tab |
| **Restore (opt-in)** | flag = **true** | Keep persisted tree **only if** `validateRestorableLayoutTree` passes; else same as clean |
| **Persist** | (always) | Continue saving multi-unit tree + `activeLeafId` + `toolColumnCollapsed` via zustand `partialize` |

### Flag storage

| Layer | Key |
|-------|-----|
| appSettings (preferred) | `ui.restoreLastWorkspace` (also flat key for compatibility) |
| localStorage mirror | `crish_restore_last_workspace` (`'true'` / `'false'`) — used by `layoutTreeStore` `onRehydrateStorage` before appSettings is ready |
| Settings UI | Appearance →「启动时恢复上次工作台」 |

**Default: false.**

There is **no separate** `restoreMultiUnitLayout` flag: multi-unit is part of “restore last workspace”. Invalid multi-unit trees never restore even when the flag is on.

### Validation (restore path)

A tree is restorable only if:

1. Root is structurally valid (binary branches, finite ratios, leaf tabs)
2. `chatCount >= 1`
3. No duplicate `sessionId` on chat leaves (1 session ≤ 1 chat)
4. If `chatCount > 1`, every chat leaf has a non-empty `sessionId`
5. Tool leaves with `sessionId` must map to an existing chat session (no orphan tools)

### Dock projection on restore

Open-tab map only stores session ids (not per-tab `rightDock`). After a valid multi-unit restore:

- Do **not** apply default collapsed dock onto the tree (would strip restored tools)
- **Infer** each tab’s `rightDock` from the Conversation Unit topology (`inferDockFromSessionUnit` / `syncShellDocksFromTree`)

## 3. Implementation anchors

| Piece | Path |
|-------|------|
| Bootstrap gate | `app/hydrateWorkspaceShell.ts` |
| Tree rehydrate gate | `store/layout-tree/layoutTreeStore.ts` `onRehydrateStorage` |
| Pure validation | `store/layout-tree/layoutRestorePolicy.ts` |
| Dock sync | `store/workspace-shell/layoutRestorePolicy.ts` |
| Settings toggle | `components/SettingsAppearanceTab.tsx` |

## 4. Consequences

**Pros**

- Safe default: no surprise multi-unit / corrupt layout on upgrade or disk damage
- Opt-in power users keep multi-unit + docks across restarts
- Persist path unchanged (no dual write schemes)

**Cons / limitations**

- Per-tab dock metadata is not independently persisted; dock state is reconstructed from the tree
- Open-tabs map without session-bound leaves falls back to draft when the tree has no bindings
- Session **messages** are independent of this flag (always retained on disk)

## 5. Alternatives considered

1. **Always restore multi-unit** — rejected (D-D): high support cost for bad trees
2. **Separate `restoreMultiUnitLayout` flag** — deferred; current single switch is enough
3. **Persist full shell openTabs JSON** — larger surface; tree + map sufficient for v1
