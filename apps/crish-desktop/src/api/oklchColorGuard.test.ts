import { describe, expect, it, vi } from 'vitest';
import { parseColorToOklch, getContrastGuardedText, applyTextContrastGuard } from './oklchColorGuard';

describe('OKLCH Color Contrast Guard', () => {
  it('correctly parses hex and hsl color lightness', () => {
    const darkOklch = parseColorToOklch('#111111');
    const lightOklch = parseColorToOklch('#ffffff');
    const hslLightOklch = parseColorToOklch('hsl(35, 10%, 95%)');

    expect(darkOklch.l).toBeLessThan(0.3);
    expect(lightOklch.l).toBeGreaterThan(0.85);
    expect(hslLightOklch.l).toBeGreaterThan(0.85);
  });

  it('generates high contrast text based on background color', () => {
    const lightBgText = getContrastGuardedText('#ffffff'); // should return dark text
    const darkBgText = getContrastGuardedText('#050505'); // should return light text

    expect(lightBgText).toContain('hsl(35, 12%');
    expect(darkBgText).toContain('hsl(0, 0%');
  });

  it('applies property overrides to root element', () => {
    const styleProperties: Record<string, string> = {};
    const mockHtmlElement = {
      style: {
        setProperty: vi.fn((name, value) => {
          styleProperties[name] = value;
        }),
        getPropertyValue: vi.fn((name) => styleProperties[name] || ''),
      },
    };

    vi.stubGlobal('document', {
      documentElement: mockHtmlElement,
    });

    applyTextContrastGuard('#ffffff', false); // Light theme

    expect(mockHtmlElement.style.getPropertyValue('--text-primary')).toContain('hsl(35, 12%');
    expect(mockHtmlElement.style.getPropertyValue('--text-secondary')).toContain('hsl(35, 8%');
    expect(mockHtmlElement.style.getPropertyValue('--text-tertiary')).toContain('hsl(35, 6%');
    
    vi.unstubAllGlobals();
  });
});
