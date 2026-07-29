/**
 * Store write-ownership tags (documentation / typing aid — **not** runtime guards).
 *
 * Use these names in comments and new APIs so call sites do not dual-write
 * layout identity (shell tabs vs tree geometry vs session body).
 *
 * @see store/README.md § Layout identity ownership
 * @see docs/architecture/desktop-composition-and-stores.md § Layout identity ownership
 * @see docs/plans/progress/architecture-dedup-inventory.md #2
 */

/**
 * Logical domains that own a write. Prefer one owner per mutation class.
 *
 * | Domain | Store instance | Typical writes |
 * |--------|----------------|----------------|
 * | `session` | layoutStore via session facade | sessions[], messages, agents, draftFolder |
 * | `shell` | workspaceShellStore | openTabs, activeTabId, rightDock, shellReady |
 * | `layout-tree` | layoutTreeStore | tree root, activeLeafId, split/merge/drop |
 * | `layout-chrome` | layoutStore | sidebar, tabMode, planMode, uiSize, appSettings |
 * | `workspace-legacy` | layoutStore via workspace facade | workspaces columns/groups (pre-tree fallback) |
 */
export type StoreOwnershipDomain =
  | 'session'
  | 'shell'
  | 'layout-tree'
  | 'layout-chrome'
  | 'workspace-legacy';

/**
 * Concrete write owners (module or compositionRoot facade).
 *
 * Naming trap: compositionRoot.`layout` = **layoutStore chrome/sessions**,
 * **not** layout-tree. Tree geometry has no compositionRoot facade yet.
 */
export type StoreWriteOwner =
  | 'layoutStore'
  | 'sessionStore' // alias of layoutStore
  | 'workspaceStore' // alias of layoutStore
  | 'workspaceShellStore'
  | 'layoutTreeStore'
  | 'compositionRoot.session'
  | 'compositionRoot.shell'
  | 'compositionRoot.layout'
  | 'compositionRoot.workspace';

/** Human map: domain → preferred write entry for new code. */
export type StoreOwnership = {
  readonly domain: StoreOwnershipDomain;
  readonly writeOwner: StoreWriteOwner;
  /** Forbidden dual-write companions for the same user gesture. */
  readonly forbidAlongside?: readonly StoreWriteOwner[];
};

/** Canonical open/focus/new-draft: shell orchestrates; session body stays on layout. */
export const SHELL_TAB_OWNERSHIP = {
  domain: 'shell',
  writeOwner: 'compositionRoot.shell',
  forbidAlongside: ['layoutTreeStore', 'compositionRoot.layout'],
} as const satisfies StoreOwnership;

/** Binary tree geometry only — no tab bar / session mint. */
export const LAYOUT_TREE_OWNERSHIP = {
  domain: 'layout-tree',
  writeOwner: 'layoutTreeStore',
  forbidAlongside: ['workspaceShellStore', 'compositionRoot.shell'],
} as const satisfies StoreOwnership;

/** Session list / messages on the god layout instance (facade, not a second store). */
export const SESSION_OWNERSHIP = {
  domain: 'session',
  writeOwner: 'sessionStore',
  forbidAlongside: ['workspaceShellStore'],
} as const satisfies StoreOwnership;
