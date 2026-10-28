import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  buildSidebarPretextFont,
  measureSessionRowHeight,
  readSidebarContentWidth,
} from './sidebarMeasure';

describe('sidebarMeasure', () => {
  beforeEach(() => {
    // Stub document, canvas and window.getComputedStyle for node test environment
    const mockDocument = {
      documentElement: {
        getAttribute: () => null,
        setAttribute: () => {},
        removeAttribute: () => {},
        appendChild: () => {},
        removeChild: () => {},
      },
      createElement: (tagName: string) => {
        if (tagName === 'canvas') {
          return {
            getContext: () => ({
              measureText: (str: string) => ({ width: str.length * 10 }),
              font: '',
            }),
          };
        }
        return {
          style: {},
          setAttribute: () => {},
          removeAttribute: () => {},
        };
      },
    };
    vi.stubGlobal('document', mockDocument);

    const mockGetComputedStyle = (_el: unknown) => ({
      getPropertyValue: (prop: string) => {
        if (prop === '--sidebar-width') return '260px';
        if (prop === '--font-sans') return 'Inter';
        return '';
      },
      fontSize: '14px',
    });
    vi.stubGlobal('getComputedStyle', mockGetComputedStyle);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('buildSidebarPretextFont', () => {
    it('returns font string or empty fallback string safely', () => {
      const font = buildSidebarPretextFont();
      expect(typeof font).toBe('string');
    });
  });

  describe('readSidebarContentWidth', () => {
    it('returns 228 fallback when document is undefined', () => {
      vi.stubGlobal('document', undefined);
      expect(readSidebarContentWidth()).toBe(228);
    });

    it('calculates sidebar content width based on --sidebar-width CSS variable', () => {
      vi.stubGlobal('getComputedStyle', () => ({
        getPropertyValue: (p: string) =>
          p === '--sidebar-width' ? '300px' : '',
        fontSize: '14px',
      }));
      const width = readSidebarContentWidth();
      expect(width).toBe(268); // 300 - 32 = 268
    });

    it('clamps min width to 180 when calculated width is too small', () => {
      vi.stubGlobal('getComputedStyle', () => ({
        getPropertyValue: (p: string) =>
          p === '--sidebar-width' ? '150px' : '',
        fontSize: '14px',
      }));
      const width = readSidebarContentWidth();
      expect(width).toBe(180);
    });
  });

  describe('measureSessionRowHeight', () => {
    it('returns default height (28) when text, font, or width is invalid', () => {
      expect(measureSessionRowHeight('', '500 14px Inter', 200)).toBe(28);
      expect(measureSessionRowHeight('title', '', 200)).toBe(28);
      expect(measureSessionRowHeight('title', '500 14px Inter', 0)).toBe(28);
    });

    it('returns single-line height (28) for short single-line text', () => {
      const font = '500 14px Inter';
      const height = measureSessionRowHeight('Short', font, 500);
      expect(height).toBe(28);
    });

    it('returns multi-line height (44) for text wrapping narrow width', () => {
      const font = '500 14px Inter';
      const longText = 'This title is long enough to wrap lines';
      const height = measureSessionRowHeight(longText, font, 50);
      expect(height).toBe(44);
    });
  });
});
