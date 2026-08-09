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
 * | `layout-chrome` | layoutStore | sidebar, tabMode, uiSize, shellChrome, settingsOverlay |
 * | `terminal` | terminalStore | terminal buffers + diff buffers |
 * | `worker` | workerStore | activeWorkers / killedWorkerIds / manual workers |
 * | `permission` | permissionStore | permissionMode / plan* / command whitelist |
 * | `settings` | settingsStore | appSettings / providers / cron / mcp / tokenUsage |
 * | `workspace-legacy` | layoutStore via workspace facade | workspaces columns/groups (pre-tree fallback) |
 */
export type StoreOwnershipDomain =
  | 'session'
  | 'shell'
  | 'layout-tree'
  | 'layout-chrome'
  | 'terminal'
  | 'worker'
  | 'permission'
  | 'settings'
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
  | 'settingsUiStore' // alias of layoutStore (overlay) + permissionStore delegation
  | 'terminalStore'
  | 'workerStore'
  | 'permissionStore'
  | 'settingsStore'
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

/**
 * Canonical open/focus/new-draft: shell orchestrates; session body stays on layout.
 *
 * D9 纪律声明（T-E 状态治理）：activeSessionId vs shell openTabs 为**设计内单一手势**
 * ——shell 编排授权（workspaceShellStore 动作内部调 setActiveSessionId），
 * **组件不得双写**（同一手势同时调 setActiveSessionId 与 shell activate 会漂移）。
 * 本约束维持纪律型（无运行时守卫，成本高收益低；D5 曾用结构替代纪律，
 * 判定标准 = 是否有可测的收敛 action——本约束无，故保留纪律）。
 */
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

/**
 * D10 登记待清理：legacy open-tabs map（api/workspaceChromeTabs）与
 * workspaceShellStore.openTabs 的运行期双写路径**保留**（跨窗口/重启标签恢复
 * 依赖 legacy map 存活）。打开/聚焦路径已收敛到统一入口
 * `syncOpenTabsToLegacy`；move/close 经 moveSessionTab/closeSessionTab
 * （workspaceChromeTabs 单一模块）。migrateFromOpenTabsMap 覆盖后消费方消失时，
 * 按该入口单一 grep 删除双写，仅保留启动一次性迁移（store/README.md D10 条目）。
 */
export const LEGACY_OPEN_TABS_DUAL_WRITE = {
  domain: 'shell',
  writeOwner: 'workspaceShellStore',
  note: 'D10 登记待清理：syncOpenTabsToLegacy 收敛点；保留运行期双写',
} as const;
