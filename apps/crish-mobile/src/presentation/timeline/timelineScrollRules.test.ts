// 时间线滚动纯规则单测：锚点偏移换算（离屏尾部冻结已彻底废除）。
import {
  anchorOffsetWithinBlock,
  restoreScrollOffset,
} from './timelineScrollRules';

describe('锚点偏移换算', () => {
  it('块内偏移 = scrollY − 块顶，负数归零', () => {
    expect(anchorOffsetWithinBlock(500, 320)).toBe(180);
    expect(anchorOffsetWithinBlock(320, 320)).toBe(0);
    expect(anchorOffsetWithinBlock(100, 320)).toBe(0);
  });

  it('恢复偏移 = 块顶 + 块内偏移（往返一致）', () => {
    const offset = anchorOffsetWithinBlock(500, 320);
    expect(restoreScrollOffset(320, offset)).toBe(500);
    expect(restoreScrollOffset(0, 0)).toBe(0);
  });
});
