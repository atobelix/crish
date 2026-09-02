/**
 * workspace-shell package — 会话手势门面 + shellReady。
 *
 * | Own | Do not own |
 * |-----|------------|
 * | shellReady、lastChatLeafId、会话手势转发 | 标签数组（在 chat 叶 tabs） |
 * | open/focus/close/new-draft/promote | 二叉树几何（layout-tree 命令） |
 *
 * 禁止 bindActiveChatLeafSession / 写 openTabs / setLeafSessionId。
 *
 * compositionRoot: `.shell` → here; `.layout` → layoutStore (not tree).
 */

export * from './types';
export * from './adapterShape';
export * from './workspaceShellStore';
export * from './openTool';
export * from './layoutRestorePolicy';
export {
  pictureFromActiveLeaf,
  resolveActiveChatLeaf,
  findTabBySessionId,
  findTabByTabId,
  listAllSessionTabs,
} from './treeSessionQuery';
