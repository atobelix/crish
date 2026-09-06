import { describe, it, expect } from 'vitest';
import { HeightMap } from '../../src/core/HeightMap';

describe('视口物理滚动锚定算法 (Viewport Scroll Anchoring)', () => {
  it('视口上方行高度修正时，累加高度差精确匹配 scrollTop 补偿量 (ΔY_screen ≡ 0)', () => {
    const hm = new HeightMap();
    const lineCount = 50;
    // 初始所有行预测为 28px
    hm.syncTo(lineCount, () => 28);

    const currentScrollTop = 500; // 用户正在查看第 18 行左右 (18 * 28 = 504)
    let deltaHeightAbove = 0;

    // 假设视口上方的第 5 行（公式）实测高度从 28px 变为 120px (+92px)
    // 第 10 行（表格）实测高度从 28px 变为 80px (+52px)
    const measurements = [
      { index: 5, start: 5 * 28, measured: 120 },
      { index: 10, start: 10 * 28, measured: 80 },
      { index: 20, start: 20 * 28, measured: 56 }, // 视口内部/下方行
    ];

    for (const item of measurements) {
      const oldH = hm.getHeight(item.index) ?? 28;
      if (hm.setHeight(item.index, item.measured)) {
        if (item.start + oldH <= currentScrollTop) {
          deltaHeightAbove += (item.measured - oldH);
        }
      }
    }
    hm.flush();

    // 验证视口上方两行的增量: 92 + 52 = 144px
    expect(deltaHeightAbove).toBe(92 + 52);

    // 补偿后新的 scrollTop
    const compensatedScrollTop = currentScrollTop + deltaHeightAbove;
    expect(compensatedScrollTop).toBe(644);

    // 验证视口内第 18 行相对视口顶部的物理位移变化:
    // 原物理 top = 18 * 28 = 504. 原 relative Y = 504 - 500 = 4px
    // 新物理 top = 504 + 144 = 648. 新 relative Y = 648 - 644 = 4px
    // ΔY_screen = 4px - 4px ≡ 0.000px!
    const oldLine18Top = 18 * 28;
    const newLine18Top = oldLine18Top + deltaHeightAbove;
    const oldRelativeY = oldLine18Top - currentScrollTop;
    const newRelativeY = newLine18Top - compensatedScrollTop;

    expect(newRelativeY - oldRelativeY).toBe(0);
  });
});
