import {
  calculateDropdownLayout,
  DROPDOWN_GAP,
  DROPDOWN_MARGIN,
} from '../dropdownLayout';

describe('calculateDropdownLayout (方案 17 物理锚点数学模型求解器)', () => {
  const defaultInsets = { top: 47, bottom: 34, left: 0, right: 0 };
  const scrW = 390;
  const scrH = 844;
  const menuWidth = 170;
  const estimatedHeight = 120;

  it('断言 1：屏幕底部触发源自适应向上翻转', () => {
    // 模拟位于屏幕底部的更多按钮：Y = 750, H = 32
    // 底部可用空间 = 844 - 34 - (750 + 32) - 4 - 12 = 14dp < 120dp
    // 顶部可用空间 = 750 - 47 - 4 - 12 = 687dp > 120dp
    const result = calculateDropdownLayout({
      anchorRect: { x: 300, y: 750, width: 32, height: 32 },
      width: menuWidth,
      estimatedHeight,
      windowWidth: scrW,
      windowHeight: scrH,
      insets: defaultInsets,
    });

    expect(result.direction).toBe('up');
    expect(result.top).toBeLessThan(750);
    // 验证向上弹出的理论坐标：y - GAP - estimatedHeight = 750 - 4 - 120 = 626
    expect(result.top).toBe(626);
  });

  it('断言 1 附加：显式 placement="top" 或 placement="bottom" 尊重意图并在极端空间优雅降级', () => {
    // 即使在屏幕底部，若显式要求 bottom 且上面空间大但强制 bottom，会降级还是遵循？
    // spaceBelow < estimatedHeight, spaceAbove >= spaceBelow -> 强制 bottom 会在不足时降级为 up
    const forcedBottom = calculateDropdownLayout({
      anchorRect: { x: 300, y: 800, width: 32, height: 32 },
      placement: 'bottom',
      width: menuWidth,
      estimatedHeight,
      windowWidth: scrW,
      windowHeight: scrH,
      insets: defaultInsets,
    });
    expect(forcedBottom.direction).toBe('up');

    // 屏幕顶部显式 top，空间不足时优雅切换 down
    const forcedTop = calculateDropdownLayout({
      anchorRect: { x: 300, y: 50, width: 32, height: 32 },
      placement: 'top',
      width: menuWidth,
      estimatedHeight,
      windowWidth: scrW,
      windowHeight: scrH,
      insets: defaultInsets,
    });
    expect(forcedTop.direction).toBe('down');
  });

  it('断言 2：屏幕右侧触发源自适应向右对齐，屏幕左侧触发源自适应向左对齐', () => {
    // 屏幕右侧：x = 340, width = 30 -> center = 355 > 390 / 2 (195) -> 靠右对齐
    const rightResult = calculateDropdownLayout({
      anchorRect: { x: 340, y: 200, width: 30, height: 30 },
      width: menuWidth,
      estimatedHeight,
      windowWidth: scrW,
      windowHeight: scrH,
      insets: defaultInsets,
    });
    // 靠右对齐：left = x + w - menuWidth = 340 + 30 - 170 = 200
    expect(rightResult.left).toBe(200);
    expect(rightResult.left + menuWidth).toBeLessThanOrEqual(
      scrW - defaultInsets.right - DROPDOWN_MARGIN
    );

    // 屏幕左侧：x = 20, width = 30 -> center = 35 <= 195 -> 靠左对齐
    const leftResult = calculateDropdownLayout({
      anchorRect: { x: 20, y: 200, width: 30, height: 30 },
      width: menuWidth,
      estimatedHeight,
      windowWidth: scrW,
      windowHeight: scrH,
      insets: defaultInsets,
    });
    // 靠左对齐：left = 20
    expect(leftResult.left).toBe(20);
    expect(leftResult.left).toBeGreaterThanOrEqual(
      defaultInsets.left + DROPDOWN_MARGIN
    );
  });

  it('断言 3：视口极值边界安全夹取（防负坐标与超界飞出）', () => {
    // 模拟负坐标异常输入
    const negativeResult = calculateDropdownLayout({
      anchorRect: { x: -100, y: -500, width: 30, height: 30 },
      width: menuWidth,
      estimatedHeight,
      windowWidth: scrW,
      windowHeight: scrH,
      insets: defaultInsets,
    });
    expect(negativeResult.top).toBe(defaultInsets.top + DROPDOWN_MARGIN);
    expect(negativeResult.left).toBe(defaultInsets.left + DROPDOWN_MARGIN);

    // 模拟超出屏幕下边界与右边界的异常巨量坐标
    const overflowResult = calculateDropdownLayout({
      anchorRect: { x: 9999, y: 9999, width: 30, height: 30 },
      width: menuWidth,
      estimatedHeight,
      windowWidth: scrW,
      windowHeight: scrH,
      insets: defaultInsets,
    });
    expect(overflowResult.top).toBe(
      scrH - defaultInsets.bottom - DROPDOWN_MARGIN - estimatedHeight
    );
    expect(overflowResult.left).toBe(
      scrW - defaultInsets.right - DROPDOWN_MARGIN - menuWidth
    );
  });

  it('断言 4（2026-11-05 收敛）：anchorRect 为唯一输入，旧 top/right 兼容模式已物理删除', () => {
    // 几何单一真源：一切定位都从物理锚点矩形出发（more 面板右偏事故根因
    // 即"遗留偏移量与按钮位置解耦"），兼容分支删除后由 TS 类型层禁绝
    const pinnedLeft = calculateDropdownLayout({
      anchorRect: { x: 20, y: 60, width: 32, height: 32 },
      width: menuWidth,
      estimatedHeight,
      windowWidth: scrW,
      windowHeight: scrH,
      insets: defaultInsets,
      align: 'left',
    });
    expect(pinnedLeft.left).toBe(20);
    expect(pinnedLeft.direction).toBe('down');

    // 视口底部：向上翻转路径 finalTop = y - GAP - estimatedHeight（无需钳制）
    const flippedUp = calculateDropdownLayout({
      anchorRect: { x: 20, y: 800, width: 32, height: 32 },
      width: menuWidth,
      estimatedHeight,
      windowWidth: scrW,
      windowHeight: scrH,
      insets: defaultInsets,
    });
    expect(flippedUp.direction).toBe('up');
    expect(flippedUp.top).toBe(800 - DROPDOWN_GAP - estimatedHeight);
  });
});
