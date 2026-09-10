/**
 * 计行 SSOT（与 components/diff/LineBuffer 行边界对齐：按 '\n' 分段，含末尾空行）。
 * 供 readTextFile 等 API 层复用，避免 content.split('\n') 全量分配字符串数组回潮。
 */
export function countTextLines(text: string): number {
  if (!text) return 1;
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* '\n' */) n++;
  }
  return n;
}