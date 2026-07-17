import { describe, expect, it } from 'vitest';
import {
  assistantTurnLabel,
  isDiffSourceMode,
  mergeSessionDiffFiles,
} from './diffPanelHelpers';
import type { FileDiff } from '../store/layoutStore';

function fd(path: string, add = 1, del = 0): FileDiff {
  return {
    filePath: path,
    additions: add,
    deletions: del,
    changes: [{ type: 'addition', content: '+x' }],
  };
}

describe('isDiffSourceMode', () => {
  it('accepts session|git|list only', () => {
    expect(isDiffSourceMode('session')).toBe(true);
    expect(isDiffSourceMode('git')).toBe(true);
    expect(isDiffSourceMode('list')).toBe(true);
    expect(isDiffSourceMode('other')).toBe(false);
  });
});

describe('assistantTurnLabel', () => {
  it('includes file count and 24h time', () => {
    const ts = new Date(2026, 0, 1, 4, 17).getTime();
    const label = assistantTurnLabel({ timestamp: ts }, 4, 1);
    expect(label).toContain('回合 5');
    expect(label).toContain('1 个文件');
    expect(label).toContain('04:17');
  });

  it('omits file phrase when zero', () => {
    const label = assistantTurnLabel({ timestamp: Date.now() }, 0, 0);
    expect(label).toMatch(/^回合 1 · /);
    expect(label).not.toContain('个文件');
  });
});

describe('mergeSessionDiffFiles', () => {
  it('merges same path and sums stats', () => {
    const out = mergeSessionDiffFiles([
      { files: [fd('a.ts', 1, 0), fd('b.ts', 2, 1)] },
      { files: [fd('a.ts', 3, 1)] },
    ]);
    const a = out.find((f) => f.filePath === 'a.ts');
    expect(a?.additions).toBe(4);
    expect(a?.deletions).toBe(1);
    expect(out.some((f) => f.filePath === 'b.ts')).toBe(true);
  });
});
