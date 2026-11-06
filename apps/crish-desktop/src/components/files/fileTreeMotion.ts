/**
 * fileTreeMotion.ts — 文件树展开/折叠动效的纯函数部分（S6，G §3.1 + 审计 A 2-1）
 *
 * 展开/折叠的 flatTree 变化在结构上是「锚点目录后连续插入/删除一段子节点」。
 * diffToggleChange 只承认这种结构，其他一切变化（过滤替换、外部重载、整树刷新）
 * 均返回 null——调用方静默同步，不做动画。这是动效不与数据刷新打架的唯一关口。
 */
import type { TreeNode } from './hooks/useFileNavigation';

export interface ToggleChange {
  kind: 'expand' | 'collapse';
  /** 锚点目录在对应数组中的下标（展开：next；收起：prev） */
  anchorIndex: number;
  /** 锚点目录 path */
  anchorPath: string;
  /** 插入/删除的连续一段子节点（按 flatTree 顺序） */
  run: TreeNode[];
  /** 该段在对应数组中的起始下标（展开：next；收起：prev） */
  runStartIndex: number;
}

function pathsOf(nodes: TreeNode[]): string[] {
  return nodes.map((n) => n.path);
}

/**
 * 判定 prev → next 是否为 anchorPath 目录的一次展开/折叠。
 * 严格条件（缺一即 null）：
 * 1. 两表仅差一段连续插入（展开）或删除（收起），其余前后缀逐项相等；
 * 2. 该段紧邻锚点目录（锚点下标 = 段起始下标 − 1）；
 * 3. 段内全部节点 depth 严格大于锚点 depth（确为其子树，而非平级重排）。
 */
export function diffToggleChange(
  prev: TreeNode[],
  next: TreeNode[],
  anchorPath: string | null
): ToggleChange | null {
  if (!anchorPath) return null;
  const prevPaths = pathsOf(prev);
  const nextPaths = pathsOf(next);
  if (prevPaths.length === nextPaths.length) return null;

  const kind: ToggleChange['kind'] =
    nextPaths.length > prevPaths.length ? 'expand' : 'collapse';
  const shorter = kind === 'expand' ? prevPaths : nextPaths;
  const longer = kind === 'expand' ? nextPaths : prevPaths;

  // 首个差异下标：两表在此之前逐项相等
  let d = 0;
  while (d < shorter.length && shorter[d] === longer[d]) d++;
  const runLength = longer.length - shorter.length;
  // 差异段之后，两表剩余后缀须逐项相等（单段连续插入/删除）
  for (let i = d; i < shorter.length; i++) {
    if (shorter[i] !== longer[i + runLength]) return null;
  }
  if (d === 0) return null;

  const anchorArray = kind === 'expand' ? next : prev;
  const anchorIndex = d - 1;
  const anchor = anchorArray[anchorIndex];
  if (!anchor || anchor.path !== anchorPath) return null;

  const runArray = kind === 'expand' ? next : prev;
  const run = runArray.slice(d, d + runLength);
  if (run.length === 0) return null;
  if (run.some((n) => n.depth <= anchor.depth)) return null;

  return {
    kind,
    anchorIndex,
    anchorPath,
    run,
    runStartIndex: d,
  };
}
