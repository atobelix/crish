/**
 * apps/crish-desktop/src/api/__tests__/themePresets.test.ts
 *
 * 验证 SKIN_PRESETS 16 个预设均完整声明 P1 表面基准参数
 * （surfaceBase / surfaceTint / surfaceDeep / elevDirection）与 P2 文字基准参数（textBase）。
 */

import { describe, expect, it } from 'vitest';
import { SKIN_PRESETS } from '../themePresets';

const EXPECTED_DARK_KEYS = new Set([
  'dark-cozy',
  'deep-night',
  'dark-forest',
  'aurora',
  'cocoa',
  'burgundy',
  'cyber',
  'obsidian',
]);

describe('themePresets P1/P2 基准参数契约', () => {
  it('全部 16 个预设均包含合法的 surfaceBase / surfaceTint / surfaceDeep / elevDirection / textBase', () => {
    const entries = Object.entries(SKIN_PRESETS);
    expect(entries.length).toBe(16);

    for (const [key, preset] of entries) {
      expect(preset.surfaceBase, `${key}.surfaceBase`).toMatch(
        /^#[0-9a-f]{6}$/i
      );
      expect(preset.surfaceTint, `${key}.surfaceTint`).toMatch(
        /^#[0-9a-f]{6}$/i
      );
      expect(preset.surfaceDeep, `${key}.surfaceDeep`).toMatch(
        /^#[0-9a-f]{6}$/i
      );
      expect(preset.textBase, `${key}.textBase`).toMatch(/^#[0-9a-f]{6}$/i);

      const expectedDir = EXPECTED_DARK_KEYS.has(key) ? 1 : -1;
      expect(preset.elevDirection, `${key}.elevDirection`).toBe(expectedDir);
    }
  });
});
