/**
 * CrishGrid — 树状嵌套布局引擎。
 * 
 * 参考 VS Code 的 Grid / BranchNode / LeafNode 结构。
 * 支持任意深度的横向/纵向嵌套。
 */

export type GridDirection = 'horizontal' | 'vertical';

export interface GridNodeBase {
  /** 最小尺寸（px） */
  minSize: number;
  /** 当前尺寸（px，0 = 按比例分配） */
  size?: number;
}

export interface GridBranch extends GridNodeBase {
  type: 'branch';
  direction: GridDirection;
  children: GridNode[];
  /** 各子节点的比例（0-1，必须与 children 等长） */
  ratios: number[];
}

export interface GridLeaf extends GridNodeBase {
  type: 'leaf';
  /** 面板类型 */
  panelType: string;
  /** 标签页 ID 列表 */
  tabs: string[];
  /** 当前活动标签页 */
  activeTab: string;
}

export type GridNode = GridBranch | GridLeaf;

/**
 * 从 Grid 树结构展平为行列的映射信息。
 */
export interface GridFlattenInfo {
  /** 深度遍历顺序 */
  order: number[];
  /** 叶子节点（真实面板）列表 */
  leaves: Array<{ leaf: GridLeaf; path: number[] }>;
  /** 分支节点（列/分组）列表 */
  branches: Array<{ branch: GridBranch; path: number[]; depth: number }>;
}

/**
 * 深度遍历 Grid 树，收集所有节点信息。
 */
export function flattenGrid(node: GridNode, path: number[] = []): GridFlattenInfo {
  const leaves: Array<{ leaf: GridLeaf; path: number[] }> = [];
  const branches: Array<{ branch: GridBranch; path: number[]; depth: number }> = [];

  function walk(n: GridNode, p: number[], depth: number): void {
    if (n.type === 'leaf') {
      leaves.push({ leaf: n, path: p });
    } else {
      branches.push({ branch: n, path: p, depth });
      n.children.forEach((child, i) => walk(child, [...p, i], depth + 1));
    }
  }

  walk(node, path, 0);
  return { order: [], leaves, branches };
}

type GridCardLike = { id?: string; type?: string };

/**
 * 从现有 WorkspaceState 构建 Grid 树。
 */
export function fromWorkspaceState(ws: { columns: Array<{ widthRatio: number; groups: Array<{ heightRatio: number; activeCard?: GridCardLike; cards: GridCardLike[] }> }> }): GridNode {
  if (ws.columns.length === 1) {
    return fromGroups(ws.columns[0]!.groups);
  }

  return {
    type: 'branch',
    direction: 'horizontal',
    minSize: 100,
    children: ws.columns.map((col) => fromGroups(col.groups)),
    ratios: ws.columns.map((col) => col.widthRatio),
  };
}

function fromGroups(groups: Array<{ heightRatio: number; activeCard?: GridCardLike; cards: GridCardLike[] }>): GridNode {
  if (groups.length === 1) {
    return fromGroup(groups[0]!);
  }

  return {
    type: 'branch',
    direction: 'vertical',
    minSize: 50,
    children: groups.map((g) => fromGroup(g)),
    ratios: groups.map((g) => g.heightRatio),
  };
}

function fromGroup(group: { activeCard?: GridCardLike; cards: GridCardLike[] }): GridLeaf {
  return {
    type: 'leaf',
    minSize: 50,
    panelType: group.activeCard?.type || 'unknown',
    tabs: group.cards.map((c) => c.id ?? ''),
    activeTab: group.activeCard?.id || group.cards[0]?.id || '',
  };
}
