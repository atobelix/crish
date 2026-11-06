/**
 * fileTreeMotion.diffToggleChange 测试（S6）
 * 覆盖：展开/折叠的单段连续变化被承认；过滤替换、外部重载、锚点不符、
 * 非子树段、平级重排一律拒绝（返回 null，调用方静默同步）。
 */
import { describe, it, expect } from 'vitest';
import { diffToggleChange } from './fileTreeMotion';
import type { TreeNode } from './hooks/useFileNavigation';

function node(path: string, depth: number, isDir = false): TreeNode {
  return {
    name: path.split('/').pop() ?? path,
    path,
    depth,
    isDir,
  } as TreeNode;
}

const BASE: TreeNode[] = [
  node('src', 0, true),
  node('src/a.ts', 1),
  node('src/b.ts', 1),
  node('README.md', 0),
];

describe('diffToggleChange', () => {
  it('展开：锚点后连续插入子树段', () => {
    const next: TreeNode[] = [
      node('src', 0, true),
      node('src/lib', 1, true),
      node('src/lib/x.ts', 2),
      node('src/lib/y.ts', 2),
      node('src/a.ts', 1),
      node('src/b.ts', 1),
      node('README.md', 0),
    ];
    const change = diffToggleChange(BASE, next, 'src');
    expect(change).not.toBeNull();
    expect(change?.kind).toBe('expand');
    expect(change?.anchorIndex).toBe(0);
    expect(change?.runStartIndex).toBe(1);
    expect(change?.run.map((n) => n.path)).toEqual([
      'src/lib',
      'src/lib/x.ts',
      'src/lib/y.ts',
    ]);
  });

  it('收起：锚点后连续删除子树段', () => {
    const prev: TreeNode[] = [
      node('src', 0, true),
      node('src/lib', 1, true),
      node('src/lib/x.ts', 2),
      node('src/a.ts', 1),
      node('src/b.ts', 1),
      node('README.md', 0),
    ];
    const change = diffToggleChange(prev, BASE, 'src');
    expect(change).not.toBeNull();
    expect(change?.kind).toBe('collapse');
    expect(change?.run.map((n) => n.path)).toEqual([
      'src/lib',
      'src/lib/x.ts',
    ]);
  });

  it('无变化：返回 null', () => {
    expect(diffToggleChange(BASE, [...BASE], 'src')).toBeNull();
  });

  it('锚点为空：返回 null', () => {
    const next = [...BASE.slice(0, 1), node('src/z.ts', 1), ...BASE.slice(1)];
    expect(diffToggleChange(BASE, next, null)).toBeNull();
  });

  it('锚点不符（变化不在记录的目录之后）：返回 null', () => {
    const next: TreeNode[] = [
      node('src', 0, true),
      node('src/a.ts', 1),
      node('src/b.ts', 1),
      node('docs', 0, true),
      node('docs/guide.md', 1),
      node('README.md', 0),
    ];
    expect(diffToggleChange(BASE, next, 'src')).toBeNull();
  });

  it('段内含平级节点（depth 不大于锚点）：返回 null', () => {
    const next: TreeNode[] = [
      node('src', 0, true),
      node('src/a.ts', 1),
      node('other', 0, true),
      node('src/b.ts', 1),
      node('README.md', 0),
    ];
    expect(diffToggleChange(BASE, next, 'src')).toBeNull();
  });

  it('两处以上变化（外部重载）：返回 null', () => {
    const next: TreeNode[] = [
      node('src', 0, true),
      node('src/a.ts', 1),
      node('src/c.ts', 1),
      node('README.md', 0),
      node('CHANGELOG.md', 0),
    ];
    expect(diffToggleChange(BASE, next, 'src')).toBeNull();
  });

  it('过滤替换（整表重排）：返回 null', () => {
    const next: TreeNode[] = [node('src/b.ts', 1), node('src/a.ts', 1)];
    expect(diffToggleChange(BASE, next, 'src')).toBeNull();
  });

  it('末尾目录展开：锚点为末行仍承认', () => {
    const prev: TreeNode[] = [node('src', 0, true), node('docs', 0, true)];
    const next: TreeNode[] = [
      node('src', 0, true),
      node('docs', 0, true),
      node('docs/g.md', 1),
    ];
    const change = diffToggleChange(prev, next, 'docs');
    expect(change?.kind).toBe('expand');
    expect(change?.anchorIndex).toBe(1);
    expect(change?.run.map((n) => n.path)).toEqual(['docs/g.md']);
  });
});
