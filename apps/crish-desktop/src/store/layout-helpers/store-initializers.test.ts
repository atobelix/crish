import { describe, expect, it } from 'vitest';
import {
  finiteNumber,
  parseUiSize,
  isSettingsTabType,
  parseSettingsTab,
  sanitizeTokenUsage,
  sanitizeActiveWorkers,
  clampActiveWorkspaceIndex,
  seedInitialWorkspaces,
} from './store-initializers';

describe('store-initializers', () => {
  it('finiteNumber returns fallback for non-finite values', () => {
    expect(finiteNumber(10, 0)).toBe(10);
    expect(finiteNumber(NaN, 5)).toBe(5);
    expect(finiteNumber(Infinity, 5)).toBe(5);
    expect(finiteNumber('abc', 5)).toBe(5);
  });

  it('parseUiSize returns valid size or medium fallback', () => {
    expect(parseUiSize('small')).toBe('small');
    expect(parseUiSize('large')).toBe('large');
    expect(parseUiSize('invalid')).toBe('medium');
  });

  it('isSettingsTabType validates tab IDs', () => {
    expect(isSettingsTabType('profile')).toBe(true);
    expect(isSettingsTabType('unknown')).toBe(false);
  });

  it('parseSettingsTab returns valid fallback', () => {
    expect(parseSettingsTab('appearance')).toBe('appearance');
    expect(parseSettingsTab('invalid')).toBe('profile');
  });

  it('sanitizeTokenUsage handles null/undefined and boundary values', () => {
    expect(sanitizeTokenUsage(null)).toEqual({
      input: 0,
      inputMax: 160000,
      output: 0,
      outputMax: 40000,
      cost: 0,
    });
    expect(sanitizeTokenUsage({ input: -5, inputMax: 0 })).toEqual({
      input: 0,
      inputMax: 1,
      output: 0,
      outputMax: 40000,
      cost: 0,
    });
  });

  it('sanitizeActiveWorkers filters invalid items', () => {
    expect(sanitizeActiveWorkers([null, { id: 'w1', elapsedSeconds: 10 }])).toEqual([
      { id: 'w1', taskName: '', elapsedSeconds: 10 },
    ]);
  });

  it('clampActiveWorkspaceIndex clamps index to array bounds', () => {
    const ws: any[] = [{ id: '1' }, { id: '2' }];
    expect(clampActiveWorkspaceIndex(ws, -1)).toBe(0);
    expect(clampActiveWorkspaceIndex(ws, 5)).toBe(1);
    expect(clampActiveWorkspaceIndex([], 2)).toBe(0);
  });

  it('seedInitialWorkspaces creates default workspace with no ghosts', () => {
    const ws = seedInitialWorkspaces();
    expect(ws.length).toBe(1);
    expect(ws[0]!.id).toBe('ws-0');
  });
});
