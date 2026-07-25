import { describe, it, expect } from 'vitest';
import { fromWorkspaceState, flattenGrid } from './crishGrid';
import type { GridBranch, GridLeaf } from './crishGrid';

describe('fromWorkspaceState', () => {
  it('单列单组 → leaf', () => {
    const ws = {
      columns: [{
        widthRatio: 1,
        groups: [{ heightRatio: 1, activeCard: { id: 'c1', type: 'chat' }, cards: [{ id: 'c1', type: 'chat' }] }],
      }],
    } as any;

    const root = fromWorkspaceState(ws);
    expect(root.type).toBe('leaf');
    expect((root as GridLeaf).panelType).toBe('chat');
  });

  it('双列单组 → horizontal branch', () => {
    const ws = {
      columns: [
        { widthRatio: 0.5, groups: [{ heightRatio: 1, activeCard: { id: 'c1', type: 'chat' }, cards: [{ id: 'c1', type: 'chat' }] }] },
        { widthRatio: 0.5, groups: [{ heightRatio: 1, activeCard: { id: 'c2', type: 'files' }, cards: [{ id: 'c2', type: 'files' }] }] },
      ],
    } as any;

    const root = fromWorkspaceState(ws);
    expect(root.type).toBe('branch');
    const branch = root as GridBranch;
    expect(branch.direction).toBe('horizontal');
    expect(branch.children).toHaveLength(2);
    expect(branch.ratios[0]).toBe(0.5);
  });
});

describe('flattenGrid', () => {
  it('单 leaf → 1 leaf, 0 branches', () => {
    const leaf: GridLeaf = { type: 'leaf', minSize: 50, panelType: 'chat', tabs: ['c1'], activeTab: 'c1' };
    const info = flattenGrid(leaf);
    expect(info.leaves).toHaveLength(1);
    expect(info.branches).toHaveLength(0);
  });

  it('horizontal branch with 2 leaves → 2 leaves, 1 branch', () => {
    const grid: GridBranch = {
      type: 'branch',
      direction: 'horizontal',
      minSize: 100,
      ratios: [0.5, 0.5],
      children: [
        { type: 'leaf', minSize: 50, panelType: 'chat', tabs: ['c1'], activeTab: 'c1' },
        { type: 'leaf', minSize: 50, panelType: 'files', tabs: ['c2'], activeTab: 'c2' },
      ],
    };

    const info = flattenGrid(grid);
    expect(info.leaves).toHaveLength(2);
    expect(info.branches).toHaveLength(1);
  });
});
