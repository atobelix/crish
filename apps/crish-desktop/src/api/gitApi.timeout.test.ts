import { describe, expect, it } from 'vitest';
import { withTimeout } from './gitApi';

describe('withTimeout (git hang guard)', () => {
  it('resolves with promise value when faster than limit', async () => {
    const v = await withTimeout(Promise.resolve(42), 200, () => -1);
    expect(v).toBe(42);
  });

  it('returns onTimeout when promise never settles in time', async () => {
    const hung = new Promise<number>(() => {
      /* never settle */
    });
    const v = await withTimeout(hung, 40, () => 7);
    expect(v).toBe(7);
  });

  it('returns onTimeout when promise rejects', async () => {
    const v = await withTimeout(Promise.reject(new Error('boom')), 200, () => 0);
    expect(v).toBe(0);
  });
});
