/**
 * X-03（AA-05）：zustand store 的 window 全局暴露仅限开发环境。
 *
 * 生产构建不得把会话/布局 store 挂到 window——任何注入脚本可直接读写
 * （篡改会话、注入伪造消息、读取本地内容）。因此统一收敛到本函数，
 * 由 `isDev`（= `import.meta.env.DEV`）门控；测试环境（vitest 下 DEV=true）
 * 与既有调试脚本不受影响。
 */
export function exposeStoresForDev(
  stores: Record<string, unknown>,
  isDev: boolean,
): void {
  if (!isDev) return;
  const w = window as unknown as Record<string, unknown>;
  for (const [key, store] of Object.entries(stores)) {
    w[key] = store;
  }
}
