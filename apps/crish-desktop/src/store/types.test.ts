import { describe, expect, it } from 'vitest';
import type { FileDiff } from './types';
import { classifyFileDiff } from '../api/applyFileDiff';

describe('FileDiff / store types', () => {
  it('should support provisional field', () => {
    const diff: FileDiff = {
      filePath: 'src/example.ts',
      additions: 2,
      deletions: 0,
      changes: [{ type: 'addition', content: 'console.log("hello");' }],
      provisional: true,
    };
    expect(diff.provisional).toBe(true);
  });

  it('should reject provisional diff via classifyFileDiff', () => {
    const diff: FileDiff = {
      filePath: 'src/example.ts',
      additions: 1,
      deletions: 0,
      changes: [{ type: 'addition', content: 'const x = 1;' }],
      provisional: true,
    };
    const result = classifyFileDiff(diff);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('provisional');
    }
  });
});
