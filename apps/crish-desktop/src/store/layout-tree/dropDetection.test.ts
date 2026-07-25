import { describe, it, expect } from 'vitest';
import {
  detectDropZone,
  findLeafAtPointer,
  isPointerInRect,
  rectFromDOM,
  type Rect,
} from './dropDetection';

function makeRect(
  left: number,
  top: number,
  width: number,
  height: number
): Rect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  };
}

const FULL_PANEL = makeRect(0, 0, 1000, 800);

describe('detectDropZone', () => {
  it('detects center as merge-tab', () => {
    const result = detectDropZone({ x: 500, y: 400 }, FULL_PANEL, 'leaf-1');
    expect(result.type).toBe('merge-tab');
    expect(result.targetLeafId).toBe('leaf-1');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('detects left edge as split-left', () => {
    const result = detectDropZone({ x: 20, y: 400 }, FULL_PANEL, 'leaf-1');
    expect(result.type).toBe('split-left');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('detects right edge as split-right', () => {
    const result = detectDropZone({ x: 980, y: 400 }, FULL_PANEL, 'leaf-1');
    expect(result.type).toBe('split-right');
  });

  it('detects top edge as split-top', () => {
    const result = detectDropZone({ x: 500, y: 20 }, FULL_PANEL, 'leaf-1');
    expect(result.type).toBe('split-top');
  });

  it('detects bottom edge as split-bottom', () => {
    const result = detectDropZone({ x: 500, y: 780 }, FULL_PANEL, 'leaf-1');
    expect(result.type).toBe('split-bottom');
  });

  it('narrow panel has larger edge zone', () => {
    const narrow = makeRect(0, 0, 100, 800);
    // At x=20 (20% of 100px), should be in edge zone for narrow panel
    const result = detectDropZone({ x: 20, y: 400 }, narrow, 'leaf-1');
    expect(result.type).toBe('split-left');
  });

  it('corner resolves to nearest edge', () => {
    // Top-left corner: closer to left (x=10) than top (y=30)
    const result = detectDropZone({ x: 10, y: 30 }, FULL_PANEL, 'leaf-1');
    expect(result.type).toBe('split-left');
  });

  it('confidence is always between 0 and 1', () => {
    const positions = [
      { x: 5, y: 400 },
      { x: 100, y: 400 },
      { x: 500, y: 400 },
      { x: 500, y: 5 },
      { x: 995, y: 795 },
    ];
    for (const pos of positions) {
      const result = detectDropZone(pos, FULL_PANEL, 'leaf-1');
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('custom options override defaults', () => {
    // Very large edge threshold: almost everything is edge
    const result = detectDropZone({ x: 300, y: 400 }, FULL_PANEL, 'leaf-1', {
      edgeThreshold: 0.4,
      centerBias: 0.45,
    });
    expect(result.type).toBe('split-left');
  });
});

describe('isPointerInRect', () => {
  it('returns true for pointer inside', () => {
    expect(isPointerInRect({ x: 50, y: 50 }, makeRect(0, 0, 100, 100))).toBe(
      true
    );
  });

  it('returns false for pointer outside', () => {
    expect(isPointerInRect({ x: 150, y: 50 }, makeRect(0, 0, 100, 100))).toBe(
      false
    );
  });

  it('returns true for pointer on edge', () => {
    expect(isPointerInRect({ x: 0, y: 0 }, makeRect(0, 0, 100, 100))).toBe(
      true
    );
    expect(isPointerInRect({ x: 100, y: 100 }, makeRect(0, 0, 100, 100))).toBe(
      true
    );
  });
});

describe('findLeafAtPointer', () => {
  const rects = [
    { id: 'left', rect: makeRect(0, 0, 500, 800) },
    { id: 'right', rect: makeRect(500, 0, 500, 800) },
  ];

  it('finds correct leaf', () => {
    const result = findLeafAtPointer({ x: 250, y: 400 }, rects);
    expect(result?.id).toBe('left');
  });

  it('finds right leaf', () => {
    const result = findLeafAtPointer({ x: 750, y: 400 }, rects);
    expect(result?.id).toBe('right');
  });

  it('returns null for pointer outside all', () => {
    const result = findLeafAtPointer({ x: 1500, y: 400 }, rects);
    expect(result).toBeNull();
  });

  it('returns null for empty list', () => {
    expect(findLeafAtPointer({ x: 50, y: 50 }, [])).toBeNull();
  });
});

describe('rectFromDOM', () => {
  it('converts DOMRect-like object', () => {
    const domRect = {
      left: 10,
      top: 20,
      right: 110,
      bottom: 120,
      width: 100,
      height: 100,
    } as DOMRect;
    const rect = rectFromDOM(domRect);
    expect(rect).toEqual({
      left: 10,
      top: 20,
      right: 110,
      bottom: 120,
      width: 100,
      height: 100,
    });
  });
});
