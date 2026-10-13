/**
 * Git 变动文件状态数据契约与增删微条纯函数算法
 * 文件路径：apps/crish-desktop/src/api/gitTreeHelpers.ts
 */

/**
 * Git 状态单字符标准代码
 */
export type GitStatusCode = 'M' | 'A' | 'D' | 'U' | 'C' | 'R' | '?';

/**
 * Git 文件状态数据契约
 */
export interface GitStatusFile {
  path: string;
  status: GitStatusCode;
  additions?: number;
  deletions?: number;
  conflicted?: boolean;
  staged?: boolean;
}

/**
 * 增删统计微条度量契约
 */
export interface DiffStatMetric {
  additions: number;
  deletions: number;
  maxBars?: number; // 默认 5 格
}

export interface DiffStatBarsResult {
  addBars: number;
  delBars: number;
  emptyBars: number;
}

/**
 * 计算增删比例微条格数
 */
export function calculateDiffStatBars(
  additions: number,
  deletions: number,
  maxBars: number = 5
): DiffStatBarsResult {
  const safeAdd = Math.max(0, additions || 0);
  const safeDel = Math.max(0, deletions || 0);
  const total = safeAdd + safeDel;
  if (total === 0 || maxBars <= 0) {
    return { addBars: 0, delBars: 0, emptyBars: maxBars > 0 ? maxBars : 0 };
  }

  const addBars = Math.min(maxBars, Math.round((safeAdd / total) * maxBars));
  const delBars = Math.min(
    maxBars - addBars,
    Math.round((safeDel / total) * maxBars)
  );
  const emptyBars = Math.max(0, maxBars - addBars - delBars);

  return { addBars, delBars, emptyBars };
}
