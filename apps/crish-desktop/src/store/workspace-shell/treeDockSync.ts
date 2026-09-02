/**
 * tree→shell 反向投影已删除（I5：坞权威在 SessionTab.dock）。
 *
 * 保留 registerTreeDockSync 空实现：维 03 workspaceShellStore 仍 re-export，
 * bootstrap 仍调用。订阅不再反推 rightDock。
 */
export function registerTreeDockSync(): () => void {
  return () => {};
}
