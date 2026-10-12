import { describe, expect, it } from 'vitest';
import { STORAGE_PERSIST_DEBOUNCE_MS } from './persistenceConstants';

describe('persistenceConstants', () => {
  it('exports STORAGE_PERSIST_DEBOUNCE_MS as 300', () => {
    expect(STORAGE_PERSIST_DEBOUNCE_MS).toBe(300);
  });

  it('has valid debounce timing contract properties', () => {
    expect(typeof STORAGE_PERSIST_DEBOUNCE_MS).toBe('number');
    expect(Number.isInteger(STORAGE_PERSIST_DEBOUNCE_MS)).toBe(true);
    expect(STORAGE_PERSIST_DEBOUNCE_MS).toBeGreaterThan(0);
  });

  it('can be imported dynamically and matches named export contract', async () => {
    const mod = await import('./persistenceConstants');
    expect(mod.STORAGE_PERSIST_DEBOUNCE_MS).toBe(300);
    expect(Object.keys(mod)).toContain('STORAGE_PERSIST_DEBOUNCE_MS');
  });
});
