import { describe, expect, it } from 'vitest';
import {
  clampRatio,
  clampSpatialRatio,
  collectSpatialLeaves,
  createSpatialBranch,
  findSpatialNode,
  flattenSpatialTree,
  isSpatialBranch,
  isSpatialLeaf,
  mintSpatialBranchId,
  removeSpatialBranch,
  replaceSpatialNode,
  type BaseSpatialLeaf,
} from './spatialTree';

interface TestLeaf extends BaseSpatialLeaf {
  type: 'leaf';
  id: string;
  name: string;
}

function makeLeaf(id: string, name = id): TestLeaf {
  return { type: 'leaf', id, name };
}

describe('spatialTree - 基础原语与类型守卫', () => {
  it('clampRatio 比例钳制算法在 [0.2, 0.8] 物理安全区间', () => {
    expect(clampRatio(0.5)).toBe(0.5);
    expect(clampRatio(0.2)).toBe(0.2);
    expect(clampRatio(0.8)).toBe(0.8);
    expect(clampRatio(0.1)).toBe(0.2);
    expect(clampRatio(0.9)).toBe(0.8);
    expect(clampRatio(NaN)).toBe(0.5);
    expect(clampSpatialRatio(0.35)).toBe(0.35);
  });

  it('mintSpatialBranchId 生成唯一标识', () => {
    const id1 = mintSpatialBranchId();
    const id2 = mintSpatialBranchId();
    expect(id1).toMatch(/^sbranch_[0-9a-z]+_[0-9a-z]+$/);
    expect(id1).not.toBe(id2);
  });

  it('isSpatialLeaf 与 isSpatialBranch 判定准确', () => {
    const leaf = makeLeaf('l1');
    const branch = createSpatialBranch('horizontal', leaf, makeLeaf('l2'));

    expect(isSpatialLeaf(leaf)).toBe(true);
    expect(isSpatialLeaf(branch)).toBe(false);
    expect(isSpatialLeaf(null as any)).toBe(false);
    expect(isSpatialLeaf({} as any)).toBe(false);

    expect(isSpatialBranch(branch)).toBe(true);
    expect(isSpatialBranch(leaf)).toBe(false);
    expect(isSpatialBranch(null as any)).toBe(false);
  });
});

describe('spatialTree - 拓扑遍历与纯函数变换', () => {
  it('findSpatialNode 深度优先搜索节点', () => {
    const l1 = makeLeaf('l1');
    const l2 = makeLeaf('l2');
    const l3 = makeLeaf('l3');
    const branchInner = createSpatialBranch('vertical', l2, l3, 0.5, 'b_inner');
    const root = createSpatialBranch(
      'horizontal',
      l1,
      branchInner,
      0.5,
      'b_root'
    );

    expect(findSpatialNode(root, 'l1')).toBe(l1);
    expect(findSpatialNode(root, 'l3')).toBe(l3);
    expect(findSpatialNode(root, 'b_inner')).toBe(branchInner);
    expect(findSpatialNode(root, 'b_root')).toBe(root);
    expect(findSpatialNode(root, 'non_existent')).toBeNull();
  });

  it('collectSpatialLeaves 前序遍历收集所有叶片', () => {
    const l1 = makeLeaf('l1');
    const l2 = makeLeaf('l2');
    const l3 = makeLeaf('l3');
    const branchInner = createSpatialBranch('vertical', l2, l3);
    const root = createSpatialBranch('horizontal', l1, branchInner);

    const leaves = collectSpatialLeaves(root);
    expect(leaves.map((l) => l.id)).toEqual(['l1', 'l2', 'l3']);
  });

  it('replaceSpatialNode 不可变替换节点', () => {
    const l1 = makeLeaf('l1');
    const l2 = makeLeaf('l2');
    const root = createSpatialBranch('horizontal', l1, l2, 0.5, 'b1');

    const l2Updated = makeLeaf('l2', 'Updated L2');
    const newRoot = replaceSpatialNode(root, 'l2', l2Updated);

    expect(newRoot).not.toBe(root);
    expect(isSpatialBranch(newRoot)).toBe(true);
    if (!isSpatialBranch(newRoot)) return;
    expect(newRoot.children[0]).toBe(l1);
    expect(newRoot.children[1]).toBe(l2Updated);

    // 目标不存在时返回原引用
    expect(replaceSpatialNode(root, 'not_found', l1)).toBe(root);
  });

  it('removeSpatialBranch 移除指定叶子并自动提升兄弟节点', () => {
    const l1 = makeLeaf('l1');
    const l2 = makeLeaf('l2');
    const root2 = createSpatialBranch('horizontal', l1, l2, 0.5, 'b1');

    // 移除 l2，提升 l1
    const res1 = removeSpatialBranch(root2, 'l2');
    expect(res1).toBe(l1);

    // 移除 l1，提升 l2
    const res2 = removeSpatialBranch(root2, 'l1');
    expect(res2).toBe(l2);

    // 三节点树：移除最深处的叶子
    const l3 = makeLeaf('l3');
    const inner = createSpatialBranch('vertical', l2, l3, 0.5, 'b_inner');
    const root3 = createSpatialBranch('horizontal', l1, inner, 0.5, 'b_root');

    const res3 = removeSpatialBranch(root3, 'l3');
    expect(isSpatialBranch(res3!)).toBe(true);
    if (!isSpatialBranch(res3!)) return;
    expect(res3.children[0]).toBe(l1);
    expect(res3.children[1]).toBe(l2); // inner 塌缩提升为 l2

    // 目标本身即 root
    expect(removeSpatialBranch(l1, 'l1')).toBeNull();
  });
});

describe('spatialTree - 几何展平与面积守恒', () => {
  it('单叶退化态展平', () => {
    const l1 = makeLeaf('l1');
    const flat = flattenSpatialTree(l1);

    expect(flat.leaves.length).toBe(1);
    expect(flat.branches.length).toBe(0);
    expect(flat.leaves[0].rect).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it('多分枝空间展平几何面积守恒', () => {
    const l1 = makeLeaf('l1');
    const l2 = makeLeaf('l2');
    const l3 = makeLeaf('l3');
    const l4 = makeLeaf('l4');

    const bLeft = createSpatialBranch('vertical', l1, l2, 0.4);
    const bRight = createSpatialBranch('vertical', l3, l4, 0.6);
    const root = createSpatialBranch('horizontal', bLeft, bRight, 0.5);

    const flat = flattenSpatialTree(root);
    expect(flat.leaves.length).toBe(4);
    expect(flat.branches.length).toBe(3);

    // 计算总面积和
    const totalArea = flat.leaves.reduce((sum, item) => {
      return sum + item.rect.width * item.rect.height;
    }, 0);
    expect(totalArea).toBeCloseTo(1.0, 4);

    // 校验 Sash 几何分割线
    expect(flat.branches[0].sash.direction).toBe('horizontal');
    expect(flat.branches[0].sash.x).toBe(0.5);
  });
});
