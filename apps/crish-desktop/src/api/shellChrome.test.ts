import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHELL_CHROME,
  parseShellChromeMode,
  SHELL_CHROME_IDS,
} from './shellChrome';

describe('parseShellChromeMode', () => {
  it('accepts classic and inset', () => {
    expect(parseShellChromeMode('classic')).toBe('classic');
    expect(parseShellChromeMode('inset')).toBe('inset');
  });

  it('falls back to classic for junk', () => {
    expect(parseShellChromeMode(undefined)).toBe(DEFAULT_SHELL_CHROME);
    expect(parseShellChromeMode(null)).toBe('classic');
    expect(parseShellChromeMode('')).toBe('classic');
    expect(parseShellChromeMode('tabs')).toBe('classic');
  });

  it('exports both mode ids', () => {
    expect([...SHELL_CHROME_IDS]).toEqual(['classic', 'inset']);
  });
});
