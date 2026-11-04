// 时间线滚动纯规则单测（批 B ⑱㉕）：尾部冻结迟滞带与锚点偏移换算。
import {
  anchorOffsetWithinBlock,
  restoreScrollOffset,
  shouldFreezeTail,
  TAIL_FREEZE_ENTER_PX,
  TAIL_FREEZE_EXIT_PX,
} from './timelineScrollRules';

describe('shouldFreezeTail（迟滞 160/320）', () => {
  it('迟滞带常量口径：进入 320 / 退出 160', () => {
    expect(TAIL_FREEZE_ENTER_PX).toBe(320);
    expect(TAIL_FREEZE_EXIT_PX).toBe(160);
  });

  it('未冻结：越过进入线才冻结，线内/屏内不冻结', () => {
    expect(shouldFreezeTail(TAIL_FREEZE_ENTER_PX, false)).toBe(false);
    expect(shouldFreezeTail(TAIL_FREEZE_ENTER_PX + 1, false)).toBe(true);
    expect(shouldFreezeTail(200, false)).toBe(false);
    expect(shouldFreezeTail(-50, false)).toBe(false);
  });

  it('已冻结：回到退出线以内才解冻（迟滞带内保持冻结）', () => {
    expect(shouldFreezeTail(200, true)).toBe(true);
    expect(shouldFreezeTail(TAIL_FREEZE_EXIT_PX + 1, true)).toBe(true);
    expect(shouldFreezeTail(TAIL_FREEZE_EXIT_PX, true)).toBe(false);
    expect(shouldFreezeTail(0, true)).toBe(false);
  });
});

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
