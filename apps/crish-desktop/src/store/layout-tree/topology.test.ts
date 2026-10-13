import { describe, expect, it } from 'vitest';
import {
  analyzeBranchResizeTopology,
  collectSubtreeLeafIds,
  findSubtreeNodeById,
  isLeafAffectedByBranch,
} from './topology';
import {
  createLeaf,
  LAYOUT_TREE_VERSION,
  type LayoutBranch,
  type LayoutLeaf,
  type LayoutTree,
} from './types';

function makeLeaf(id: string): LayoutLeaf {
  return createLeaf({ id });
}

function makeBranch(
  id: string,
  direction: 'horizontal' | 'vertical',
  first: LayoutBranch | LayoutLeaf,
  second: LayoutBranch | LayoutLeaf,
  splitRatio = 0.5
): LayoutBranch {
  return {
    type: 'branch',
    id,
    direction,
    children: [first, second],
    splitRatio,
  };
}

describe('layout-tree/topology (二叉树子树叶子收集与 Gated Resizing 门控分析)', () => {
  /**
   * 构造深度为 4 的复杂二叉树：
   *                 [B-root (horizontal)]
   *                 /                   \
   *        [B-left (vertical)]        [B-right (horizontal)]
   *          /            \              /               \
   *     [leaf-1]    [B-left-sub]     [leaf-4]       [B-right-sub]
   *                   /       \                       /        \
   *              [leaf-2]   [leaf-3]             [leaf-5]   [B-deep]
   *                                                           /    \
   *                                                      [leaf-6] [leaf-7]
   */
  const leaf1 = makeLeaf('leaf-1');
  const leaf2 = makeLeaf('leaf-2');
  const leaf3 = makeLeaf('leaf-3');
  const leaf4 = makeLeaf('leaf-4');
  const leaf5 = makeLeaf('leaf-5');
  const leaf6 = makeLeaf('leaf-6');
  const leaf7 = makeLeaf('leaf-7');

  const branchLeftSub = makeBranch('B-left-sub', 'horizontal', leaf2, leaf3);
  const branchLeft = makeBranch('B-left', 'vertical', leaf1, branchLeftSub);
  const branchDeep = makeBranch('B-deep', 'vertical', leaf6, leaf7);
  const branchRightSub = makeBranch(
    'B-right-sub',
    'vertical',
    leaf5,
    branchDeep
  );
  const branchRight = makeBranch(
    'B-right',
    'horizontal',
    leaf4,
    branchRightSub
  );
  const rootBranch = makeBranch(
    'B-root',
    'horizontal',
    branchLeft,
    branchRight
  );

  const layoutTree: LayoutTree = {
    root: rootBranch,
    version: LAYOUT_TREE_VERSION,
  };

  it('拖拽根分支 B-root 时，collectSubtreeLeafIds 精确返回整棵树全部 7 个叶子节点（左到右顺序）', () => {
    expect(collectSubtreeLeafIds(rootBranch, 'B-root')).toEqual([
      'leaf-1',
      'leaf-2',
      'leaf-3',
      'leaf-4',
      'leaf-5',
      'leaf-6',
      'leaf-7',
    ]);
    // 单参数直接传入分支节点同样生效
    expect(collectSubtreeLeafIds(rootBranch)).toEqual([
      'leaf-1',
      'leaf-2',
      'leaf-3',
      'leaf-4',
      'leaf-5',
      'leaf-6',
      'leaf-7',
    ]);
    // 支持直接传入 LayoutTree 包装结构
    expect(collectSubtreeLeafIds(layoutTree, 'B-root')).toEqual([
      'leaf-1',
      'leaf-2',
      'leaf-3',
      'leaf-4',
      'leaf-5',
      'leaf-6',
      'leaf-7',
    ]);
  });

  it('拖拽左子树中间分支 B-left 时，仅锁定左侧 3 个受形变叶子，右侧 4 个窗格完全豁免', () => {
    expect(collectSubtreeLeafIds(rootBranch, 'B-left')).toEqual([
      'leaf-1',
      'leaf-2',
      'leaf-3',
    ]);

    const analysis = analyzeBranchResizeTopology(rootBranch, 'B-left');
    expect(analysis.branch).toBe(branchLeft);
    expect(analysis.affectedLeafIds).toEqual(['leaf-1', 'leaf-2', 'leaf-3']);
    expect(analysis.unaffectedLeafIds).toEqual([
      'leaf-4',
      'leaf-5',
      'leaf-6',
      'leaf-7',
    ]);
  });

  it('拖拽叶子相邻分支 B-left-sub 或最深层分支 B-deep 时，仅锁定直接下属的 2 个叶子', () => {
    expect(collectSubtreeLeafIds(rootBranch, 'B-left-sub')).toEqual([
      'leaf-2',
      'leaf-3',
    ]);
    expect(collectSubtreeLeafIds(rootBranch, 'B-deep')).toEqual([
      'leaf-6',
      'leaf-7',
    ]);
    expect(collectSubtreeLeafIds(rootBranch, 'B-right-sub')).toEqual([
      'leaf-5',
      'leaf-6',
      'leaf-7',
    ]);
  });

  it('退化树测试：仅有 1 个叶子的退化树返回自身 ID，查询不存在的 branchId 返回空数组', () => {
    const singleLeaf = makeLeaf('solo-leaf');
    expect(collectSubtreeLeafIds(singleLeaf)).toEqual(['solo-leaf']);
    expect(collectSubtreeLeafIds(singleLeaf, 'solo-leaf')).toEqual([
      'solo-leaf',
    ]);
    expect(collectSubtreeLeafIds(singleLeaf, 'missing-branch')).toEqual([]);
    expect(collectSubtreeLeafIds(rootBranch, 'missing-branch')).toEqual([]);
  });

  it('空值与异常边界保护：传入 null 或 undefined 安全返回空数组', () => {
    expect(collectSubtreeLeafIds(null)).toEqual([]);
    expect(collectSubtreeLeafIds(undefined)).toEqual([]);
    expect(collectSubtreeLeafIds(null, 'B-root')).toEqual([]);
    expect(findSubtreeNodeById(null, 'B-root')).toBeNull();
    expect(findSubtreeNodeById(rootBranch, '')).toBeNull();
  });

  it('isLeafAffectedByBranch 精确判定指定窗格是否属于当前拖拽分支的影响域', () => {
    expect(isLeafAffectedByBranch(rootBranch, 'B-left-sub', 'leaf-2')).toBe(
      true
    );
    expect(isLeafAffectedByBranch(rootBranch, 'B-left-sub', 'leaf-3')).toBe(
      true
    );
    expect(isLeafAffectedByBranch(rootBranch, 'B-left-sub', 'leaf-1')).toBe(
      false
    );
    expect(isLeafAffectedByBranch(rootBranch, 'B-left-sub', 'leaf-4')).toBe(
      false
    );
    expect(isLeafAffectedByBranch(null, 'B-left-sub', 'leaf-2')).toBe(false);
  });
});
