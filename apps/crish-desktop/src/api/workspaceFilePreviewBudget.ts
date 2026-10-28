/** 首屏预览行数；长文件可再分段加载 */
export const FILE_PREVIEW_CHUNK_LINES = 400;
/** 后端硬上限对齐 fs_commands 安全最大行数 */
export const FILE_PREVIEW_MAX_LINES = 20000;
/** 虚拟化代码与文档预览全量预算（解除 400 行截断手铐，直连虚拟 DOM） */
export const FILE_PREVIEW_CODE_BUDGET = FILE_PREVIEW_MAX_LINES;

/**
 * 下一段预览行预算（纯函数，供 UI 与单测共用）。
 * 返回 null 表示已达上限，不应再请求。
 */
export function nextFilePreviewLineBudget(
  currentBudget: number,
  chunk: number = FILE_PREVIEW_CHUNK_LINES,
  max: number = FILE_PREVIEW_MAX_LINES
): number | null {
  const cur = Math.max(0, Math.floor(currentBudget));
  const step = Math.max(1, Math.floor(chunk));
  const cap = Math.max(1, Math.floor(max));
  if (cur >= cap) return null;
  return Math.min(cap, cur + step);
}
