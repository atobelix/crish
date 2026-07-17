import { describe, expect, it } from 'vitest';
import {
  COMPOSER_DENSE_LINE_HEIGHT,
  COMPOSER_LINE_HEIGHT,
  COMPOSER_MAX_LINES,
  COMPOSER_MIN_LINES,
  composerMaxHeightPx,
  resolveComposerLineHeightPx,
} from './useAutoGrowTextarea';

describe('useAutoGrowTextarea / composerMaxHeightPx', () => {
  it('defaults to 2–10 line grow contract + dense line-height token', () => {
    expect(COMPOSER_MIN_LINES).toBe(2);
    expect(COMPOSER_MAX_LINES).toBe(10);
    expect(COMPOSER_LINE_HEIGHT).toBe(1.45);
    expect(COMPOSER_DENSE_LINE_HEIGHT).toBe(1.4);
  });

  it('computes max height as lineHeight × lines + padY', () => {
    // 20px line × 10 + 0 pad
    expect(composerMaxHeightPx(20, 10)).toBe(200);
    expect(composerMaxHeightPx(20, 2, 6)).toBe(46);
    // dense 侧栏常 3 行
    expect(composerMaxHeightPx(18, 3)).toBe(54);
  });

  it('clamps maxLines to at least 1', () => {
    expect(composerMaxHeightPx(18, 0)).toBe(18);
    expect(composerMaxHeightPx(18, -3)).toBe(18);
    expect(composerMaxHeightPx(18, 1.9)).toBe(18); // floor → 1
    expect(composerMaxHeightPx(18, 4.8)).toBe(72); // floor → 4
  });

  it('falls back when lineHeight is invalid', () => {
    expect(composerMaxHeightPx(NaN, 4)).toBe(80); // 20 * 4
    expect(composerMaxHeightPx(0, 4)).toBe(80);
    expect(composerMaxHeightPx(-1, 4)).toBe(80);
  });

  it('ignores negative padY', () => {
    expect(composerMaxHeightPx(16, 4, -8)).toBe(64);
  });

  it('resolveComposerLineHeightPx handles px / unitless / normal', () => {
    const px = {
      fontSize: '14px',
      lineHeight: '20.3px',
    } as CSSStyleDeclaration;
    expect(resolveComposerLineHeightPx(px)).toBeCloseTo(20.3, 5);

    const unitless = {
      fontSize: '14px',
      lineHeight: '1.45',
    } as CSSStyleDeclaration;
    expect(resolveComposerLineHeightPx(unitless)).toBeCloseTo(14 * 1.45, 5);

    const normal = {
      fontSize: '16px',
      lineHeight: 'normal',
    } as CSSStyleDeclaration;
    expect(resolveComposerLineHeightPx(normal)).toBeCloseTo(16 * 1.45, 5);

    const dense = {
      fontSize: '13px',
      lineHeight: 'normal',
    } as CSSStyleDeclaration;
    expect(
      resolveComposerLineHeightPx(dense, COMPOSER_DENSE_LINE_HEIGHT),
    ).toBeCloseTo(13 * 1.4, 5);
  });
});
