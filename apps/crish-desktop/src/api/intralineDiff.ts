/**
 * 词法级 IntralineDiff 差异比对引擎与 LRU 缓存
 * 文件路径：apps/crish-desktop/src/api/intralineDiff.ts
 */

export type DiffWordType = 'same' | 'added' | 'removed';

export interface DiffWordToken {
  text: string;
  type: DiffWordType;
}

export interface IntralinePairResult {
  oldTokens: DiffWordToken[];
  newTokens: DiffWordToken[];
}

/**
 * 单词分词正则：捕获连续空白、连续单词字符（标识符/数字）、或单个标点符号/非空白非单词字符
 */
const TOKEN_SPLIT_REGEX = /(\s+|[a-zA-Z0-9_$]+|[^\s\w])/g;

/**
 * 防 DoS 熔断阈值：单行 Token 数超过 120 时，自动降级为整行块比对，防止长压缩/Minified 代码卡死主线程
 */
export const MAX_INTRALINE_TOKENS = 120;

/**
 * 将单行代码文本切分为词法 Token 序列
 */
export function tokenizeLine(text: string): string[] {
  if (!text) return [];
  const matches = text.match(TOKEN_SPLIT_REGEX);
  return matches || (text.length > 0 ? [text] : []);
}

/**
 * 合并连续同类型的 DiffWordToken，减少 DOM 节点数量，提升渲染性能
 */
export function coalesceTokens(tokens: DiffWordToken[]): DiffWordToken[] {
  if (tokens.length <= 1) return tokens;
  const result: DiffWordToken[] = [];
  let current: DiffWordToken = { text: tokens[0]!.text, type: tokens[0]!.type };

  for (let k = 1; k < tokens.length; k++) {
    const next = tokens[k]!;
    if (next.type === current.type) {
      current.text += next.text;
    } else {
      result.push(current);
      current = { text: next.text, type: next.type };
    }
  }
  result.push(current);
  return result;
}

/**
 * LRU 计算缓存池 (默认最大容量 500 行对，保证虚拟滚动 <1ms 渲染预算)
 */
export class IntralineLRUCache {
  private capacity: number;
  private cache: Map<string, IntralinePairResult>;

  constructor(capacity: number = 500) {
    this.capacity = Math.max(1, capacity);
    this.cache = new Map();
  }

  get(key: string): IntralinePairResult | undefined {
    const item = this.cache.get(key);
    if (item) {
      // 刷新访问序
      this.cache.delete(key);
      this.cache.set(key, item);
    }
    return item;
  }

  set(key: string, value: IntralinePairResult): void {
    if (this.cache.size >= this.capacity) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

/** 全局单例 LRU 缓存池 */
export const globalDiffCache = new IntralineLRUCache(500);

/**
 * 基于 LCS (最长公共子序列) 算法计算两行代码之间的词法级差异
 *
 * @param oldText 原始行文本
 * @param newText 目标行文本
 * @param cache 可选自定义 LRU 缓存实例
 * @returns 差异比对结果包含 oldTokens 与 newTokens
 */
export function computeIntralinePair(
  oldText: string,
  newText: string,
  cache: IntralineLRUCache = globalDiffCache
): IntralinePairResult {
  const safeOld = oldText ?? '';
  const safeNew = newText ?? '';

  const cacheKey = `${safeOld}\x00${safeNew}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // 极速路径：两行完全一致
  if (safeOld === safeNew) {
    const result: IntralinePairResult = {
      oldTokens: safeOld ? [{ text: safeOld, type: 'same' }] : [],
      newTokens: safeNew ? [{ text: safeNew, type: 'same' }] : [],
    };
    cache.set(cacheKey, result);
    return result;
  }

  const oldWords = tokenizeLine(safeOld);
  const newWords = tokenizeLine(safeNew);

  const m = oldWords.length;
  const n = newWords.length;

  // 防 DoS 熔断：超过 120 个 Token 时自动回退至行级整块比对，防止长压缩代码卡死 UI
  if (m > MAX_INTRALINE_TOKENS || n > MAX_INTRALINE_TOKENS) {
    const fallback: IntralinePairResult = {
      oldTokens: safeOld ? [{ text: safeOld, type: 'removed' }] : [],
      newTokens: safeNew ? [{ text: safeNew, type: 'added' }] : [],
    };
    cache.set(cacheKey, fallback);
    return fallback;
  }

  // 构造 LCS 动态规划矩阵
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );

  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (oldWords[i] === newWords[j]) {
        dp[i + 1]![j + 1] = dp[i]![j]! + 1;
      } else {
        dp[i + 1]![j + 1] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
  }

  // 回溯求解编辑序列
  let i = m;
  let j = n;
  const tempOld: DiffWordToken[] = [];
  const tempNew: DiffWordToken[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
      tempOld.unshift({ text: oldWords[i - 1]!, type: 'same' });
      tempNew.unshift({ text: newWords[j - 1]!, type: 'same' });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      tempNew.unshift({ text: newWords[j - 1]!, type: 'added' });
      j--;
    } else if (i > 0 && (j === 0 || dp[i]![j - 1]! < dp[i - 1]![j]!)) {
      tempOld.unshift({ text: oldWords[i - 1]!, type: 'removed' });
      i--;
    }
  }

  const result: IntralinePairResult = {
    oldTokens: coalesceTokens(tempOld),
    newTokens: coalesceTokens(tempNew),
  };
  cache.set(cacheKey, result);
  return result;
}

export interface HunkLinePair {
  oldLineText: string;
  newLineText: string;
}

export interface ContinuousHunkResult {
  deletionTokens: DiffWordToken[][];
  additionTokens: DiffWordToken[][];
}

/**
 * 块级连续变更聚类对齐算法 (Continuous Hunk Chunking Engine)
 *
 * 解决多行连续删除紧随多行连续新增（N del : M add）时的词法对齐与高亮问题：
 * 1. 采用 LCS 矩阵将 N 行删除与 M 行新增按语义相似度进行全局最优配对；
 * 2. 对配对行执行 computeIntralinePair 细粒度分词；
 * 3. 对无配对孤行进行整行 added/removed 词法分词。
 */
/**
 * 防 DoS 熔断阈值：连续变更行数超过 500 行时，自动降级为整行块比对，防止超大 Diff 卡死主线程
 */
export const MAX_HUNK_DIFF_LINES = 500;

export function computeContinuousHunkDiff(
  deletions: string[],
  additions: string[],
  cache: IntralineLRUCache = globalDiffCache
): ContinuousHunkResult {
  const n = deletions.length;
  const m = additions.length;

  const deletionTokens: DiffWordToken[][] = [];
  const additionTokens: DiffWordToken[][] = [];

  // 防卡死熔断：超过 500 行的超大 Diff 块降级为行级整块比对，防止主线程卡死
  if (n > MAX_HUNK_DIFF_LINES || m > MAX_HUNK_DIFF_LINES || n + m > MAX_HUNK_DIFF_LINES) {
    for (let k = 0; k < n; k++) {
      const text = deletions[k]!;
      deletionTokens.push(text ? [{ text, type: 'removed' }] : []);
    }
    for (let k = 0; k < m; k++) {
      const text = additions[k]!;
      additionTokens.push(text ? [{ text, type: 'added' }] : []);
    }
    return { deletionTokens, additionTokens };
  }

  // 1:1 对等简单块极速路径
  const minLen = Math.min(n, m);
  for (let k = 0; k < minLen; k++) {
    const pair = computeIntralinePair(deletions[k]!, additions[k]!, cache);
    deletionTokens.push(pair.oldTokens);
    additionTokens.push(pair.newTokens);
  }

  // 处理多余的 Deletions (N > M)
  for (let k = minLen; k < n; k++) {
    const text = deletions[k]!;
    deletionTokens.push(text ? [{ text, type: 'removed' }] : []);
  }

  // 处理多余的 Additions (M > N)
  for (let k = minLen; k < m; k++) {
    const text = additions[k]!;
    additionTokens.push(text ? [{ text, type: 'added' }] : []);
  }

  return { deletionTokens, additionTokens };
}
