// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  normalizeCodeIndent,
  normalizeTheme,
  normalizeUiSize,
} from './useAppearanceSettings';

describe('useAppearanceSettings 归一化', () => {
  it('theme 仅 dark / default', () => {
    expect(normalizeTheme('dark')).toBe('dark');
    expect(normalizeTheme('light')).toBe('default');
    expect(normalizeTheme(undefined)).toBe('default');
  });

  it('密度非法值回落 medium', () => {
    expect(normalizeUiSize('small')).toBe('small');
    expect(normalizeUiSize('nope')).toBe('medium');
  });

  it('代码缩进白名单', () => {
    expect(normalizeCodeIndent('    ')).toBe('    ');
    expect(normalizeCodeIndent('\t')).toBe('\t');
    expect(normalizeCodeIndent('weird')).toBe('  ');
  });
});
