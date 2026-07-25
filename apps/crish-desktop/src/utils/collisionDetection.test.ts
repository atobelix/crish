import { describe, it, expect } from 'vitest';
import {
  isPointerInRect,
  fiveZoneDetection,
  nestedCollisionDetection,
  computeDropIndicatorRect,
} from './collisionDetection';
import type { CardRect } from './collisionDetection';

const mockRect: CardRect = { left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 };

describe('isPointerInRect', () => {
  it('指针在矩形内返回 true', () => {
    expect(isPointerInRect({ x: 50, y: 50 }, mockRect)).toBe(true);
    expect(isPointerInRect({ x: 0, y: 0 }, mockRect)).toBe(true);
    expect(isPointerInRect({ x: 199, y: 99 }, mockRect)).toBe(true);
  });
  it('指针在矩形外返回 false', () => {
    expect(isPointerInRect({ x: -1, y: 50 }, mockRect)).toBe(false);
    expect(isPointerInRect({ x: 50, y: 101 }, mockRect)).toBe(false);
  });
  it('padding 扩展检测范围', () => {
    expect(isPointerInRect({ x: -5, y: 50 }, mockRect, 10)).toBe(true);
  });
});

describe('fiveZoneDetection', () => {
  const wideRect: CardRect = { left: 0, top: 0, right: 300, bottom: 100, width: 300, height: 100 };
  it('leftEdge — x < 12.5%', () => {
    expect(fiveZoneDetection({ x: 20, y: 50 }, wideRect)).toBe('leftEdge');
  });
  it('rightEdge — x > 87.5%', () => {
    expect(fiveZoneDetection({ x: 280, y: 50 }, wideRect)).toBe('rightEdge');
  });
  it('top — y < 20%', () => {
    expect(fiveZoneDetection({ x: 150, y: 10 }, wideRect)).toBe('top');
  });
  it('center — default', () => {
    expect(fiveZoneDetection({ x: 150, y: 50 }, wideRect)).toBe('center');
  });
  it('bottom — y > 80%', () => {
    expect(fiveZoneDetection({ x: 150, y: 90 }, wideRect)).toBe('bottom');
  });
  it('窄卡片（≤200px）跳过左右边缘', () => {
    const narrowRect: CardRect = { left: 0, top: 0, right: 150, bottom: 100, width: 150, height: 100 };
    expect(fiveZoneDetection({ x: 10, y: 50 }, narrowRect)).not.toBe('leftEdge');
    expect(fiveZoneDetection({ x: 10, y: 50 }, narrowRect)).toBe('center');
  });
});

describe('nestedCollisionDetection', () => {
  it('Level 1: 精确命中', () => {
    const result = nestedCollisionDetection(
      { x: 50, y: 50 },
      [{ id: 'card1', rect: mockRect }],
    );
    expect(result?.level).toBe(1);
    expect(result?.cardId).toBe('card1');
  });
  it('Level 2: 阈值内最近', () => {
    const smallRect: CardRect = { left: 0, top: 0, right: 10, bottom: 100, width: 10, height: 100 };
    const result = nestedCollisionDetection(
      { x: -10, y: 50 },
      [{ id: 'card1', rect: smallRect }],
      20,
    );
    expect(result?.level).toBe(2);
    expect(result?.cardId).toBe('card1');
  });
  it('Level 4: 无匹配返回 null', () => {
    const result = nestedCollisionDetection(
      { x: 999, y: 999 },
      [],
    );
    expect(result).toBeNull();
  });
});

describe('computeDropIndicatorRect', () => {
  const canvasRect: CardRect = { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 };
  it('insert-col-left 返回竖线', () => {
    const result = computeDropIndicatorRect(
      { type: 'insert-col-left', wsId: 'ws-0', colIdx: 0, groupIdx: 0, rect: { left: 100, top: 0, right: 300, bottom: 600, width: 200, height: 600 } },
      canvasRect,
    );
    expect(result.className).toBe('drop-indicator-line-v');
    expect(result.width).toBe(3);
    expect(result.left).toBeCloseTo(98.5);
  });
});
