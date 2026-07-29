import { describe, expect, it } from 'vitest';
import type { FileDiff } from '../store/types';
import { classifyFileDiff } from '../api/applyFileDiff';

describe('DiffCardFileList', () => {
  it('should disable Accept button for provisional diff', () => {
    const provisionalDiff: FileDiff = {
      filePath: 'src/components/Button.tsx',
      additions: 3,
      deletions: 1,
      changes: [{ type: 'addition', content: 'export const Button = () => null;' }],
      provisional: true,
    };

    const classification = classifyFileDiff(provisionalDiff);
    expect(classification.ok).toBe(false);
    // In DiffCardFileList, disabled={applyBusy || !classifyFileDiff(f).ok}
    const isAcceptDisabled = !classification.ok;
    expect(isAcceptDisabled).toBe(true);
  });
});
