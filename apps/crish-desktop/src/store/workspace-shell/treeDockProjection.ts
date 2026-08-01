/**
 * tree↔shell 双向投影抑制标志（T06.9.1）。
 *
 * 背景：shell 经 applyDockToTree / ensureChatOnlyTree 等把 dock 投影到
 * layoutTreeStore 时，tree 的 setState 会同步触发反向订阅
 * （registerTreeDockSync → syncShellDocksFromTree）——若不抑制，
 * 每次 shell→tree 投影都会立刻被反向推一次，形成互触发回环噪音
 * （AA-03 Q06：applyDockToTree ↔ syncShellDocksFromTree）。
 *
 * 语义：投影期间置位 → 反向订阅跳过本次同步；投影结束后复位，
 * 后续用户拖拽 / 分屏等纯 tree 变更仍照常反推 shell dock 元数据。
 * 深度计数保证嵌套投影（applyDockToTree → applyDockToSession）正确配对，
 * 异常路径经 finally 确保复位。
 */

let projectionDepth = 0;

/** 当前是否处于 shell→tree 投影中（反向订阅据此跳过本次同步） */
export function isTreeDockProjectionSuppressed(): boolean {
  return projectionDepth > 0;
}

/** 在抑制标志生效期间执行 fn（嵌套安全；异常时确保复位） */
export function withTreeDockProjectionSuppressed<T>(fn: () => T): T {
  projectionDepth += 1;
  try {
    return fn();
  } finally {
    projectionDepth -= 1;
  }
}
