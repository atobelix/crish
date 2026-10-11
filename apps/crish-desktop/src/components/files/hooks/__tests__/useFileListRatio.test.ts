import { describe, expect, it } from 'vitest';
import { normalizeFileListRatio } from '../useFileListRatio';

describe('normalizeFileListRatio', () => {
  it('accepts stored ratios and percentages within the existing bounds', () => {
    expect(normalizeFileListRatio(0.35)).toBe(35);
    expect(normalizeFileListRatio(15)).toBe(15);
    expect(normalizeFileListRatio(75)).toBe(75);
  });

  it('rejects non-finite, non-numeric, and out-of-range preferences', () => {
    for (const value of [undefined, null, '35', Number.NaN, Infinity, 0.14, 76]) {
      expect(normalizeFileListRatio(value)).toBeUndefined();
    }
  });
});
