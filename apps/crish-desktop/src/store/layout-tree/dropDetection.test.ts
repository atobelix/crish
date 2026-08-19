import { beforeEach, describe, it, expect } from 'vitest';
import { viewRegistry } from '../../services/view-registry';
import { setPrimaryPanelChecker } from './index';
import {
  detectDropZone,
  findLeafAtPointer,
  isPointerInRect,
  isUnitScopedDropAllowed,
  isZoneSame,
  rectFromDOM,
  type DropZone,
  type Rect,
} from './dropDetection';

beforeEach(() => {
  setPrimaryPanelChecker((id) => viewRegistry.isPrimary(id));
});

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

// ── isZoneSame ──────────────────────────────────────────────────────
//
// DropZone 浅相等比较的纯函数测试。
//
// 核心不变量：
// 1. 仅比较语义字段（type + targetLeafId）— confidence 不参与
// 2. null 安全（两侧 null / 单侧 null / 双侧非 null）
// 3. 引用相等短路（a === b → true，避免深比较开销）
//
// 使用场景：useTreeDrag 在 pointermove 期间用 isZoneSame 做 zone 去重，
// 避免 confidence 浮动触发无效 store setActiveDropZone → 订阅组件 re-render。

// ── isUnitScopedDropAllowed ─────────────────────────────────────────
//
// Conversation Unit 作用域：tool 拖拽不得跨 session。
// 与 applyDrop 共用，保证预览 zone 与 commit 拒绝规则一致。

describe('isUnitScopedDropAllowed — unit scope rejection matrix', () => {
  it('chat 源：任意目标 session → 允许', () => {
    expect(isUnitScopedDropAllowed('chat', 's1', 'chat', 's2')).toBe(true);
    expect(isUnitScopedDropAllowed('chat', 's1', 'diff', 's2')).toBe(true);
    expect(isUnitScopedDropAllowed('chat', undefined, 'chat', 's2')).toBe(true);
  });

  it('tool 源无 owner：任意目标 → 允许（兼容旧单坞）', () => {
    expect(isUnitScopedDropAllowed('diff', undefined, 'terminal', 's2')).toBe(
      true
    );
    expect(isUnitScopedDropAllowed('terminal', '', 'files', 's1')).toBe(true);
    expect(isUnitScopedDropAllowed('files', undefined, 'diff', undefined)).toBe(
      true
    );
  });

  it('tool 源 s1 → tool 目标 s1 → 允许', () => {
    expect(isUnitScopedDropAllowed('diff', 's1', 'terminal', 's1')).toBe(true);
    expect(isUnitScopedDropAllowed('terminal', 's1', 'files', 's1')).toBe(true);
  });

  it('tool 源 s1 → tool 目标 s2 → 拒绝（跨 session tool merge/split）', () => {
    expect(isUnitScopedDropAllowed('diff', 's1', 'terminal', 's2')).toBe(false);
    expect(isUnitScopedDropAllowed('files', 'sess-a', 'agent', 'sess-b')).toBe(
      false
    );
  });

  it('tool 源 s1 → chat 目标 s2 → 拒绝（他 session 的 chat）', () => {
    expect(isUnitScopedDropAllowed('diff', 's1', 'chat', 's2')).toBe(false);
  });

  it('tool 源 s1 → chat 目标 s1 → 允许（域隔离另由 isSameDomain 拒绝）', () => {
    // 本函数只管 session 层；同 session 的 chat 目标在 session 上合法
    expect(isUnitScopedDropAllowed('diff', 's1', 'chat', 's1')).toBe(true);
  });

  it('tool 源 s1 → 未绑定 session 的目标 → 允许（merge 时回写 owner）', () => {
    expect(isUnitScopedDropAllowed('diff', 's1', 'terminal', undefined)).toBe(
      true
    );
    expect(isUnitScopedDropAllowed('diff', 's1', 'terminal', '')).toBe(true);
  });

  it('sessionId 空白字符视为未绑定', () => {
    expect(isUnitScopedDropAllowed('diff', '  ', 'terminal', 's2')).toBe(true);
    expect(isUnitScopedDropAllowed('diff', 's1', 'terminal', '  ')).toBe(true);
  });
});

describe('isZoneSame', () => {
  it('两个 null → true', () => {
    expect(isZoneSame(null, null)).toBe(true);
  });

  it('同引用 → true（短路）', () => {
    const zone: DropZone = {
      type: 'merge-tab',
      targetLeafId: 'leaf-1',
      confidence: 0.5,
    };
    expect(isZoneSame(zone, zone)).toBe(true);
  });

  it('同 type + 同 targetLeafId + 不同 confidence → true（confidence 不参与）', () => {
    // 这是 useTreeDrag 去重的核心场景：
    // pointermove 期间 detectDropZone 每次返回新对象引用 + 浮动 confidence，
    // 但语义不变 → isZoneSame 短路 → 不触发 store 更新。
    const a: DropZone = {
      type: 'split-left',
      targetLeafId: 'leaf-1',
      confidence: 0.4,
    };
    const b: DropZone = {
      type: 'split-left',
      targetLeafId: 'leaf-1',
      confidence: 0.9,
    };
    expect(isZoneSame(a, b)).toBe(true);
  });

  it('不同 type → false', () => {
    const a: DropZone = {
      type: 'split-left',
      targetLeafId: 'leaf-1',
      confidence: 1,
    };
    const b: DropZone = {
      type: 'split-right',
      targetLeafId: 'leaf-1',
      confidence: 1,
    };
    expect(isZoneSame(a, b)).toBe(false);
  });

  it('不同 targetLeafId → false', () => {
    const a: DropZone = {
      type: 'merge-tab',
      targetLeafId: 'leaf-1',
      confidence: 1,
    };
    const b: DropZone = {
      type: 'merge-tab',
      targetLeafId: 'leaf-2',
      confidence: 1,
    };
    expect(isZoneSame(a, b)).toBe(false);
  });

  it('一侧 null → false', () => {
    const zone: DropZone = {
      type: 'merge-tab',
      targetLeafId: 'leaf-1',
      confidence: 1,
    };
    expect(isZoneSame(zone, null)).toBe(false);
    expect(isZoneSame(null, zone)).toBe(false);
  });

  it('覆盖所有 DropZoneType（5 种）— 同 type 同 leaf 即相等', () => {
    // 验证 isZoneSame 对所有 zone 类型一致工作，无类型特殊处理
    const types: DropZone['type'][] = [
      'split-left',
      'split-right',
      'split-top',
      'split-bottom',
      'merge-tab',
    ];
    for (const type of types) {
      const a: DropZone = {
        type,
        targetLeafId: 'leaf-x',
        confidence: 0.1,
      };
      const b: DropZone = {
        type,
        targetLeafId: 'leaf-x',
        confidence: 0.99,
      };
      expect(isZoneSame(a, b)).toBe(true);
    }
  });
});
