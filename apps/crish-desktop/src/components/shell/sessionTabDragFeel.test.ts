import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SESSION_PANE_EDGE,
  SESSION_TAB_DRAG_THRESHOLD_L1,
  SESSION_TAB_INDICATOR_EASE,
  SESSION_TAB_INDICATOR_GEOM_MS,
  SESSION_TAB_INDICATOR_H,
  SESSION_TAB_INDICATOR_W,
  SESSION_TAB_STRIP_SHIFT_EASE,
  SESSION_TAB_STRIP_SHIFT_MS,
  SESSION_TAB_STRIP_SHIFT_PX,
  computeSessionTabInsertIndex,
  computeStripTabOffsets,
  detectPaneDropRegion,
  exceedsSessionTabDragThresholdL1,
  paneDropIndicatorRect,
  stripDropIndicatorRect,
} from './sessionTabDragFeel';

describe('会话 Tab 拖阈值 L1=4', () => {
  it('钉死参考 L1 常量', () => {
    expect(SESSION_TAB_DRAG_THRESHOLD_L1).toBe(4);
  });

  it('|dx|+|dy| < 4 不算拖；≥ 4 算拖（不是 hypot）', () => {
    expect(exceedsSessionTabDragThresholdL1(0, 0)).toBe(false);
    expect(exceedsSessionTabDragThresholdL1(3, 0)).toBe(false);
    expect(exceedsSessionTabDragThresholdL1(2, 1)).toBe(false);
    expect(exceedsSessionTabDragThresholdL1(4, 0)).toBe(true);
    expect(exceedsSessionTabDragThresholdL1(0, -4)).toBe(true);
    expect(exceedsSessionTabDragThresholdL1(2, 2)).toBe(true);
    expect(exceedsSessionTabDragThresholdL1(-3, 1)).toBe(true);
  });
});

describe('条内插入指数 1/3 滞后', () => {
  const tabs = [
    { left: 0, right: 150, width: 150 },
    { left: 154, right: 304, width: 150 },
  ];

  it('指针在 Tab 左侧之前 → 该下标', () => {
    expect(computeSessionTabInsertIndex(tabs, -10, 1)).toBe(0);
  });

  it('往右：过左 1/3 才后插', () => {
    expect(computeSessionTabInsertIndex(tabs, 40, 10)).toBe(0);
    expect(computeSessionTabInsertIndex(tabs, 50, 10)).toBe(1);
  });

  it('往左：过右 1/3 才前插', () => {
    // 仍在右 1/3 内 → 后插 (i+1)；越过右 1/3 进入左 2/3 → 前插 (i)
    expect(computeSessionTabInsertIndex(tabs, 110, -10)).toBe(1);
    expect(computeSessionTabInsertIndex(tabs, 100, -10)).toBe(0);
  });

  it('越过全部 Tab → 末尾', () => {
    expect(computeSessionTabInsertIndex(tabs, 400, 1)).toBe(2);
  });
});

describe('叶面 22% 边缘分区', () => {
  const pane = { left: 0, top: 0, width: 400, height: 200 };

  it('钉死 22% 边缘常量', () => {
    expect(SESSION_PANE_EDGE).toBe(0.22);
  });

  it('400×200 叶：x=0–87 left，x=88 起不算 left；中间 center；x=313–400 right', () => {
    expect(detectPaneDropRegion(0, 100, pane)).toBe('left');
    expect(detectPaneDropRegion(87, 100, pane)).toBe('left');
    expect(detectPaneDropRegion(88, 100, pane)).toBe('center');
    expect(detectPaneDropRegion(200, 100, pane)).toBe('center');
    expect(detectPaneDropRegion(312, 100, pane)).toBe('center');
    expect(detectPaneDropRegion(313, 100, pane)).toBe('right');
    expect(detectPaneDropRegion(400, 100, pane)).toBe('right');
  });

  it('左右上下 22% 为 split；中间 center', () => {
    expect(detectPaneDropRegion(20, 100, pane)).toBe('left');
    expect(detectPaneDropRegion(390, 100, pane)).toBe('right');
    expect(detectPaneDropRegion(200, 10, pane)).toBe('top');
    expect(detectPaneDropRegion(200, 190, pane)).toBe('bottom');
    expect(detectPaneDropRegion(200, 100, pane)).toBe('center');
  });

  it('叶外返回 null', () => {
    expect(detectPaneDropRegion(-1, 100, pane)).toBeNull();
    expect(detectPaneDropRegion(401, 100, pane)).toBeNull();
  });
});

describe('指示条几何', () => {
  it('条内 150×26', () => {
    expect(SESSION_TAB_INDICATOR_W).toBe(150);
    expect(SESSION_TAB_INDICATOR_H).toBe(26);
    expect(SESSION_TAB_STRIP_SHIFT_PX).toBe(154);
    const box = stripDropIndicatorRect(80, {
      left: 0,
      top: 10,
      width: 400,
      height: 32,
    });
    expect(box.width).toBe(150);
    expect(box.height).toBe(26);
    expect(box.top).toBe(10 + (32 - 26) / 2);
  });

  it('叶面半区 2px 内缩', () => {
    const r = { left: 0, top: 0, width: 400, height: 200 };
    const left = paneDropIndicatorRect('left', r);
    expect(left.left).toBe(2);
    expect(left.width).toBe(200 - 4);
    expect(left.height).toBe(196);
  });
});

describe('computeStripTabOffsets 让位位移数学模型', () => {
  it('同条向右拖：区间内标签向左补位，绝不向右多推', () => {
    // 3 个标签 [0, 1, 2]，拖动 index 0 往右插入到 index 2 的位置
    const offsets = computeStripTabOffsets({
      tabCount: 2, // 排除 sourceTab 后的剩余标签数
      sourceIndex: 0,
      insertIndex: 2,
      shiftPx: 154,
    });
    // index 0 和 1 的标签（即原 index 1 和 2）向左移动 154px 补位
    expect(offsets).toEqual([-154, -154]);
  });

  it('同条向左拖：区间内标签向右腾位', () => {
    // 原 index 2 往左插入到 index 0 的位置
    const offsets = computeStripTabOffsets({
      tabCount: 2,
      sourceIndex: 2,
      insertIndex: 0,
      shiftPx: 154,
    });
    // 0 和 1 号标签向右移动 154px 腾位
    expect(offsets).toEqual([154, 154]);
  });

  it('同条原地不动：偏移量全为 0', () => {
    const offsets = computeStripTabOffsets({
      tabCount: 2,
      sourceIndex: 1,
      insertIndex: 1,
      shiftPx: 154,
    });
    expect(offsets).toEqual([0, 0]);
  });

  it('跨条拖入开头：所有现有标签向右腾位 1 个槽位', () => {
    const offsets = computeStripTabOffsets({
      tabCount: 2,
      sourceIndex: null,
      insertIndex: 0,
      shiftPx: 154,
    });
    expect(offsets).toEqual([154, 154]);
  });

  it('跨条拖入中间：仅 insertIndex 之后的标签向右腾位', () => {
    const offsets = computeStripTabOffsets({
      tabCount: 3,
      sourceIndex: null,
      insertIndex: 1,
      shiftPx: 154,
    });
    expect(offsets).toEqual([0, 154, 154]);
  });

  it('跨条拖入末尾追加：全部标签偏移为 0', () => {
    const offsets = computeStripTabOffsets({
      tabCount: 2,
      sourceIndex: null,
      insertIndex: 2,
      shiftPx: 154,
    });
    expect(offsets).toEqual([0, 0]);
  });
});

describe('拖拽落区颜色与减速动效', () => {
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'sessionTabDrag.module.css'),
    'utf8'
  );

  it('让位与落区形变使用常规时长和减速曲线', () => {
    expect(SESSION_TAB_STRIP_SHIFT_MS).toBe(200);
    expect(SESSION_TAB_INDICATOR_GEOM_MS).toBe(200);
    expect(SESSION_TAB_STRIP_SHIFT_EASE).toBe('cubic-bezier(0.2, 0, 0, 1)');
    expect(SESSION_TAB_INDICATOR_EASE).toBe(SESSION_TAB_STRIP_SHIFT_EASE);
  });

  it('落区是品牌绿实色且无虚线边框', () => {
    expect(css).toContain(
      'color-mix(in srgb, var(--brand-primary) 18%, transparent)'
    );
    expect(css).toContain('border: none');
    expect(css).not.toContain('dashed');
    expect(css).toContain('var(--ease-decelerate)');
    expect(css).toContain('var(--duration-normal)');
    expect(css).not.toMatch(/cubic-bezier\s*\(/);
  });
});
