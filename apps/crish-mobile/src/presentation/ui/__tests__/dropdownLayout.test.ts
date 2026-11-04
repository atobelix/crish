import { calculateDropdownLayout, DROPDOWN_MARGIN } from '../dropdownLayout';

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

  it('断言 4：兼容遗留仅传 top / right 的降级表现与防溢出保护', () => {
    const legacyResult = calculateDropdownLayout({
      top: 60,
      right: 18,
      width: menuWidth,
      estimatedHeight,
      windowWidth: scrW,
      windowHeight: scrH,
      insets: defaultInsets,
    });
    // left = scrW - insets.right - right - width = 390 - 0 - 18 - 170 = 202
    expect(legacyResult.left).toBe(202);
    expect(legacyResult.top).toBe(60);
    expect(legacyResult.direction).toBe('down');

    // 遗留 top 处于屏幕极度靠下位置时自动翻转为向上
    const bottomLegacy = calculateDropdownLayout({
      top: 800,
      width: menuWidth,
      estimatedHeight,
      windowWidth: scrW,
      windowHeight: scrH,
      insets: defaultInsets,
    });
    expect(bottomLegacy.direction).toBe('up');
    // 受视口底部安全区限制，经过 safe clamping 后收口在 maxTop (678)
    expect(bottomLegacy.top).toBe(
      scrH - defaultInsets.bottom - DROPDOWN_MARGIN - estimatedHeight
    );
  });
});
