import { describe, expect, it } from 'vitest';
import {
  SESSION_PANE_EDGE,
  SESSION_TAB_DRAG_THRESHOLD_L1,
  SESSION_TAB_INDICATOR_H,
  SESSION_TAB_INDICATOR_W,
  SESSION_TAB_STRIP_SHIFT_PX,
  computeSessionTabInsertIndex,
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

describe('叶面 25% 边缘分区', () => {
  const pane = { left: 0, top: 0, width: 400, height: 200 };

  it('钉死 25% 边缘常量', () => {
    expect(SESSION_PANE_EDGE).toBe(0.25);
  });

  it('左右上下 25% 为 split；中间 center', () => {
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
