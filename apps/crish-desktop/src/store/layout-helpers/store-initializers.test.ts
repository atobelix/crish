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

  it('sanitizeTokenUsage 4D 宽容：cache 可选字段非负有限（T-47）', () => {
    // 负值钳 0；非数字 / NaN → 键省略（undefined = 未上报隐藏）
    const dirty = sanitizeTokenUsage({ cacheRead: -5, cacheWrite: 'x', savedCost: NaN });
    expect(dirty.cacheRead).toBe(0);
    expect(dirty.cacheWrite).toBeUndefined();
    expect(dirty.savedCost).toBeUndefined();

    // 双端均无 cache 字段 → 结果不含 4D 键（与既有形状一致）
    expect(sanitizeTokenUsage({ input: 1 })).not.toHaveProperty('cacheRead');

    // 任意一端提供 → 取合法非负值
    const base = {
      input: 1,
      inputMax: 2,
      output: 3,
      outputMax: 4,
      cost: 0.5,
      cacheRead: 10,
      cacheWrite: 2,
      savedCost: 0.01,
    };
    const keep = sanitizeTokenUsage({ input: 9 }, base);
    expect(keep).toEqual({
      input: 9,
      inputMax: 2,
      output: 3,
      outputMax: 4,
      cost: 0.5,
      cacheRead: 10,
      cacheWrite: 2,
      savedCost: 0.01,
    });
    const next = sanitizeTokenUsage({ input: 9, cacheRead: 20, savedCost: 0.05 }, base);
    expect(next.cacheRead).toBe(20);
    expect(next.cacheWrite).toBe(2);
    expect(next.savedCost).toBe(0.05);
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
