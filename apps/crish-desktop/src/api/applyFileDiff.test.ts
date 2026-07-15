import { describe, expect, it } from 'vitest';
import {
  classifyFileDiff,
  reconstructFullContent,
  reconstructSearchReplace,
} from './applyFileDiff';
import type { FileDiff } from '../store/types';

describe('classifyFileDiff', () => {
  it('accepts pure addition as full_write', () => {
    const d: FileDiff = {
      filePath: 'a.ts',
      additions: 2,
      deletions: 0,
      changes: [
        { type: 'addition', content: 'line1' },
        { type: 'addition', content: 'line2' },
      ],
    };
    expect(classifyFileDiff(d)).toEqual({ ok: true, mode: 'full_write' });
    expect(reconstructFullContent(d)).toBe('line1\nline2');
  });

  it('accepts del+add as search_replace', () => {
    const d: FileDiff = {
      filePath: 'b.ts',
      additions: 1,
      deletions: 1,
      changes: [
        { type: 'deletion', content: 'const a = 1' },
        { type: 'addition', content: 'const a = 2' },
      ],
    };
    expect(classifyFileDiff(d)).toEqual({ ok: true, mode: 'search_replace' });
    expect(reconstructSearchReplace(d)).toEqual({
      oldStr: 'const a = 1',
      newStr: 'const a = 2',
    });
  });

  it('rejects mixed context hunks', () => {
    const d: FileDiff = {
      filePath: 'c.ts',
      additions: 1,
      deletions: 1,
      changes: [
        { type: 'normal', content: '@@ -1,3 +1,3 @@' },
        { type: 'normal', content: 'keep' },
        { type: 'deletion', content: 'old' },
        { type: 'addition', content: 'new' },
      ],
    };
    const r = classifyFileDiff(d);
    expect(r.ok).toBe(false);
  });

  it('rejects truncated full write', () => {
    const d: FileDiff = {
      filePath: 'd.ts',
      additions: 50,
      deletions: 0,
      changes: [
        { type: 'addition', content: 'only-one' },
      ],
    };
    const r = classifyFileDiff(d);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toMatch(/截断/);
  });

  it('ignores placeholder normal-only diffs', () => {
    const d: FileDiff = {
      filePath: 'e.ts',
      additions: 0,
      deletions: 0,
      changes: [{ type: 'normal', content: '文件已更新' }],
    };
    expect(classifyFileDiff(d).ok).toBe(false);
  });
});
