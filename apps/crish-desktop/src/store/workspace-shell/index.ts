/**
 * workspace-shell package — **TabSurface / dock write owner**.
 *
 * | Own | Do not own |
 * |-----|------------|
 * | openTabs, activeTabId, rightDock, shellReady | session messages (layoutStore) |
 * | open/focus/close/new-draft tab lifecycle | binary tree geometry (layout-tree) |
 *
 * Forbidden: dual-write open path via raw `setActiveSessionId` without shell;
 * tree mutations except through layout-tree ops / shell project helpers.
 *
 * compositionRoot: `.shell` → here; `.layout` → layoutStore (not tree).
 *
 * @see ./workspaceShellStore.ts header
 * @see ../storeOwnership.ts
 */

export * from './types';
export * from './adapterShape';
export * from './workspaceShellStore';
export * from './openTool';
export * from './unitTabPlacement';
export * from './layoutRestorePolicy';
// openToolInSession 经 openTool 再导出
