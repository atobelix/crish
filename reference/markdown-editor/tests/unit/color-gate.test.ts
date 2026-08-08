import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  parseHslString,
  hslToRgb,
  hslToRgbString,
  hslToHexString,
  generateColorFallback,
  scanContentForColorViolations,
} from '../../src/core/colorAdaptor';

describe('1. Color Adaptor & Mathematical Backup Conversion Engine', () => {
  it('accurately parses modern space and slash-alpha HSL syntax', () => {
    const parsed = parseHslString('hsl(80 27.3% 97.8% / 0.65)');
    expect(parsed.h).toBeCloseTo(80, 1);
    expect(parsed.s).toBeCloseTo(27.3, 1);
    expect(parsed.l).toBeCloseTo(97.8, 1);
    expect(parsed.a).toBe(0.65);
  });

  it('accurately converts #FAFBF8 HSL definition back to RGB and HEX', () => {
    const hslTheme = 'hsl(80 27.3% 97.8%)';
    const rgb = hslToRgbString(hslTheme);
    const hex = hslToHexString(hslTheme);

    // RGB should evaluate to 250, 251, 248
    expect(rgb).toBe('rgb(250, 251, 248)');
    expect(hex).toBe('#FAFBF8');
  });

  it('accurately computes RGBA fallback string with alpha channel', () => {
    const selectionHsl = 'hsl(80 30% 86% / 0.65)';
    const fallback = generateColorFallback(selectionHsl);

    expect(fallback.rgbString).toContain('rgba(');
    expect(fallback.rgbString).toContain('0.65)');
    expect(fallback.rgbaObject.a).toBe(0.65);
    expect(fallback.rgbaObject.r).toBeGreaterThan(200);
    expect(fallback.rgbaObject.g).toBeGreaterThan(200);
  });

  it('accurately handles primary chromatic colors (Red, Green, Blue, White, Black)', () => {
    expect(hslToHexString('hsl(0 100% 50%)')).toBe('#FF0000');
    expect(hslToHexString('hsl(120 100% 50%)')).toBe('#00FF00');
    expect(hslToHexString('hsl(240 100% 50%)')).toBe('#0000FF');
    expect(hslToHexString('hsl(0 0% 100%)')).toBe('#FFFFFF');
    expect(hslToHexString('hsl(0 0% 0%)')).toBe('#000000');
  });

  it('handles out-of-range hue angles by wrapping around 360 degrees', () => {
    const wrapped = parseHslString('hsl(420 100% 50%)');
    expect(wrapped.h).toBe(60);
  });
});

describe('2. Color CI Gate - Strict Enforcement of HSL Color Policy', () => {
  it('detects violations when unauthorized HEX or legacy colors are introduced', () => {
    const badCss = `
      .bad-element {
        color: #ff0000;
        background-color: rgba(0, 0, 0, 0.5);
        border-color: hsla(210, 50%, 50%, 0.8);
      }
    `;

    const violations = scanContentForColorViolations(badCss, 'bad.css');
    expect(violations.length).toBeGreaterThanOrEqual(3);
    expect(violations.some((v) => v.reason.includes('HEX'))).toBe(true);
    expect(violations.some((v) => v.reason.includes('rgba'))).toBe(true);
  });

  it('scans all src/ CSS and Component files to guarantee 100% HSL compliance', () => {
    const srcDir = path.resolve(__dirname, '../../src');
    const allViolations: any[] = [];

    function scanDir(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.isFile() && (entry.name.endsWith('.css') || entry.name.endsWith('.tsx') || entry.name.endsWith('.ts'))) {
          // Exclude colorAdaptor.ts and tests itself from self-detection regex definitions
          if (entry.name === 'colorAdaptor.ts' || entry.name.includes('.test.')) {
            continue;
          }
          const content = fs.readFileSync(fullPath, 'utf-8');
          const violations = scanContentForColorViolations(content, entry.name);
          allViolations.push(...violations);
        }
      }
    }

    scanDir(srcDir);

    if (allViolations.length > 0) {
      console.error('Color Gate Violations Found:\n', JSON.stringify(allViolations, null, 2));
    }
    expect(allViolations).toHaveLength(0);
  });
});
