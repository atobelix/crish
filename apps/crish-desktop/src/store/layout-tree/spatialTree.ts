/**
 * 通用空间几何二叉树泛型抽象（Spatial Binary Tree）
 *
 * 纯数学几何与拓扑算子，零 DOM 依赖、无副作用。
 * 供外层工作区 LayoutTree 与内层右坞 DockTree 共享复用。
 */

export type SpatialDirection = 'horizontal' | 'vertical';

export interface BaseSpatialLeaf {
  readonly type: 'leaf';
  readonly id: string;
}

export interface SpatialBranch<
  TLeaf extends BaseSpatialLeaf = BaseSpatialLeaf,
> {
  readonly type: 'branch';
  readonly id: string;
  readonly direction: SpatialDirection;
  readonly splitRatio: number;
  readonly children: readonly [SpatialNode<TLeaf>, SpatialNode<TLeaf>];
}

export type SpatialNode<TLeaf extends BaseSpatialLeaf = BaseSpatialLeaf> =
  TLeaf | SpatialBranch<TLeaf>;

export interface SpatialTree<TLeaf extends BaseSpatialLeaf = BaseSpatialLeaf> {
  readonly root: SpatialNode<TLeaf>;
  readonly version: number;
}

export interface NormalizedRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SashSegment {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly length: number;
  readonly direction: SpatialDirection;
}

export interface FlattenedSpatialItem<
  TLeaf extends BaseSpatialLeaf = BaseSpatialLeaf,
> {
  readonly leaf: TLeaf;
  readonly rect: NormalizedRect;
}

export interface FlattenedSpatialBranch<
  TLeaf extends BaseSpatialLeaf = BaseSpatialLeaf,
> {
  readonly branch: SpatialBranch<TLeaf>;
  readonly rect: NormalizedRect;
  readonly sash: SashSegment;
}

export interface FlattenedSpatialTree<
  TLeaf extends BaseSpatialLeaf = BaseSpatialLeaf,
> {
  readonly leaves: readonly FlattenedSpatialItem<TLeaf>[];
  readonly branches: readonly FlattenedSpatialBranch<TLeaf>[];
}

export const MIN_SPATIAL_RATIO = 0.2;
export const MAX_SPATIAL_RATIO = 0.8;

/**
 * 统一比例钳制算法，严守物理安全区间 [min, max]（默认 [0.2, 0.8]）
 */
export function clampRatio(
  ratio: number,
  min = MIN_SPATIAL_RATIO,
  max = MAX_SPATIAL_RATIO
): number {
  if (typeof ratio !== 'number' || Number.isNaN(ratio)) {
    return 0.5;
  }
  const clamped = Math.min(max, Math.max(min, ratio));
  return Math.round(clamped * 1000) / 1000;
}

export const clampSpatialRatio = clampRatio;

export function isSpatialBranch<TLeaf extends BaseSpatialLeaf>(
  node: SpatialNode<TLeaf>
): node is SpatialBranch<TLeaf> {
  return (
    typeof node === 'object' &&
    node !== null &&
    (node as { type?: unknown }).type === 'branch' &&
    Array.isArray((node as { children?: unknown }).children) &&
    (node as { children: readonly unknown[] }).children.length === 2
  );
}

export function isSpatialLeaf<TLeaf extends BaseSpatialLeaf>(
  node: SpatialNode<TLeaf>
): node is TLeaf {
  return (
    typeof node === 'object' &&
    node !== null &&
    (node as { type?: unknown }).type === 'leaf' &&
    typeof (node as { id?: unknown }).id === 'string'
  );
}

export function mintSpatialBranchId(prefix = 'sbranch'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createSpatialBranch<TLeaf extends BaseSpatialLeaf>(
  direction: SpatialDirection,
  first: SpatialNode<TLeaf>,
  second: SpatialNode<TLeaf>,
  splitRatio = 0.5,
  branchId?: string
): SpatialBranch<TLeaf> {
  return {
    type: 'branch',
    id: branchId ?? mintSpatialBranchId(),
    direction,
    splitRatio: clampRatio(splitRatio),
    children: [first, second],
  };
}

export function findSpatialNode<TLeaf extends BaseSpatialLeaf>(
  root: SpatialNode<TLeaf>,
  id: string
): SpatialNode<TLeaf> | null {
  if (root.id === id) return root;
  if (isSpatialBranch(root)) {
    const left = findSpatialNode(root.children[0], id);
    if (left) return left;
    return findSpatialNode(root.children[1], id);
  }
  return null;
}

export function collectSpatialLeaves<TLeaf extends BaseSpatialLeaf>(
  root: SpatialNode<TLeaf>
): readonly TLeaf[] {
  if (isSpatialLeaf(root)) {
    return [root];
  }
  if (isSpatialBranch(root)) {
    return [
      ...collectSpatialLeaves(root.children[0]),
      ...collectSpatialLeaves(root.children[1]),
    ];
  }
  return [];
}

export function replaceSpatialNode<TLeaf extends BaseSpatialLeaf>(
  root: SpatialNode<TLeaf>,
  targetId: string,
  replacement: SpatialNode<TLeaf>
): SpatialNode<TLeaf> {
  if (root.id === targetId) {
    return replacement;
  }
  if (isSpatialLeaf(root)) {
    return root;
  }
  const [c0, c1] = root.children;
  const new0 = replaceSpatialNode(c0, targetId, replacement);
  const new1 = replaceSpatialNode(c1, targetId, replacement);
  if (new0 === c0 && new1 === c1) {
    return root;
  }
  return {
    ...root,
    children: [new0, new1],
  };
}

/**
 * 从树中移除指定叶子节点，将其兄弟节点（sibling）提升替代原父分支。
 * 若整棵树仅剩该节点本身（root.id === targetLeafId），返回 null。
 */
export function removeSpatialBranch<TLeaf extends BaseSpatialLeaf>(
  root: SpatialNode<TLeaf>,
  targetLeafId: string
): SpatialNode<TLeaf> | null {
  if (root.id === targetLeafId) {
    return null;
  }
  if (isSpatialLeaf(root)) {
    return root;
  }

  const [first, second] = root.children;
  if (first.id === targetLeafId) {
    return second;
  }
  if (second.id === targetLeafId) {
    return first;
  }

  const newFirst = removeSpatialBranch(first, targetLeafId);
  if (newFirst !== first) {
    if (newFirst === null) {
      return second;
    }
    return {
      ...root,
      children: [newFirst, second],
    };
  }

  const newSecond = removeSpatialBranch(second, targetLeafId);
  if (newSecond !== second) {
    if (newSecond === null) {
      return first;
    }
    return {
      ...root,
      children: [first, newSecond],
    };
  }

  return root;
}

/**
 * 通用几何展平算法（绝对百分比坐标计算）
 */
export function flattenSpatialTree<TLeaf extends BaseSpatialLeaf>(
  root: SpatialNode<TLeaf>,
  initialRect: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 }
): FlattenedSpatialTree<TLeaf> {
  const leaves: FlattenedSpatialItem<TLeaf>[] = [];
  const branches: FlattenedSpatialBranch<TLeaf>[] = [];

  function traverse(node: SpatialNode<TLeaf>, rect: NormalizedRect): void {
    if (isSpatialLeaf(node)) {
      leaves.push({ leaf: node, rect });
      return;
    }

    const { direction, splitRatio, children, id } = node;
    if (direction === 'horizontal') {
      const w0 = Math.round(rect.width * splitRatio * 10000) / 10000;
      const w1 = Math.round((rect.width - w0) * 10000) / 10000;
      const sashX = rect.x + w0;

      branches.push({
        branch: node,
        rect,
        sash: {
          id: `sash_${id}`,
          x: sashX,
          y: rect.y,
          length: rect.height,
          direction: 'horizontal',
        },
      });

      traverse(children[0], {
        x: rect.x,
        y: rect.y,
        width: w0,
        height: rect.height,
      });
      traverse(children[1], {
        x: sashX,
        y: rect.y,
        width: w1,
        height: rect.height,
      });
    } else {
      const h0 = Math.round(rect.height * splitRatio * 10000) / 10000;
      const h1 = Math.round((rect.height - h0) * 10000) / 10000;
      const sashY = rect.y + h0;

      branches.push({
        branch: node,
        rect,
        sash: {
          id: `sash_${id}`,
          x: rect.x,
          y: sashY,
          length: rect.width,
          direction: 'vertical',
        },
      });

      traverse(children[0], {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: h0,
      });
      traverse(children[1], {
        x: rect.x,
        y: sashY,
        width: rect.width,
        height: h1,
      });
    }
  }

  traverse(root, initialRect);
  return { leaves, branches };
}
