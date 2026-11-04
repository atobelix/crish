import {
  deriveTimelineBottomInset,
  evaluateFollowState,
} from './timelineBottomInset';

describe('deriveTimelineBottomInset', () => {
  it('键盘弹起时正确叠加键盘高度，彻底消除 316dp 的对话文字被键盘/输入框遮挡盲区', () => {
    // 无键盘：浮层 150 + gap 16 = 166
    expect(
      deriveTimelineBottomInset({
        overlayHeight: 150,
        keyboardHeight: 0,
        gap: 16,
      })
    ).toBe(166);

    // 键盘弹起 320dp：浮层 68 + 键盘 320 + gap 16 = 404，保证列表内容完整滚到输入框上方
    expect(
      deriveTimelineBottomInset({
        overlayHeight: 68,
        keyboardHeight: 320,
        gap: 16,
      })
    ).toBe(404);
  });

  it('条件层增厚（错误条/停止胶囊在场）由实测高自然带入', () => {
    const plain = deriveTimelineBottomInset({
      overlayHeight: 68,
      keyboardHeight: 0,
      gap: 16,
    });
    const withErrorBar = deriveTimelineBottomInset({
      overlayHeight: 142,
      keyboardHeight: 0,
      gap: 16,
    });
    expect(withErrorBar - plain).toBe(74);
  });

  it('负值与非有限值按 0 钳制，绝不产生负 inset', () => {
    expect(
      deriveTimelineBottomInset({
        overlayHeight: -20,
        keyboardHeight: Number.NaN,
        gap: -4,
      })
    ).toBe(0);
    expect(
      deriveTimelineBottomInset({
        overlayHeight: Number.POSITIVE_INFINITY,
        keyboardHeight: 0,
        gap: 16,
      })
    ).toBe(16);
  });

  it('实测为 0 或异常小时由 minOverlayHeight 坚守保底，绝不让最后一条消息被输入框遮挡', () => {
    // 场景 1：未开键盘、布局未完成或实测误报 0，坚守保底高 148（98 两行 + 34 安全区 + 16 padding）+ gap 20
    expect(
      deriveTimelineBottomInset({
        overlayHeight: 0,
        keyboardHeight: 0,
        gap: 20,
        minOverlayHeight: 148,
      })
    ).toBe(168);

    // 场景 2：键盘弹起 336px，实测仍为 0 时保底生效（保底 148 + 键盘 336 + gap 20 = 504）
    expect(
      deriveTimelineBottomInset({
        overlayHeight: 0,
        keyboardHeight: 336,
        gap: 20,
        minOverlayHeight: 148,
      })
    ).toBe(504);

    // 场景 3：实测值大于保底值（如展开多行或有附件），采用实测值
    expect(
      deriveTimelineBottomInset({
        overlayHeight: 180,
        keyboardHeight: 0,
        gap: 20,
        minOverlayHeight: 148,
      })
    ).toBe(200);
  });
});

describe('evaluateFollowState 迟滞带状态机', () => {
  it('处于跟随态 (follow = true) 时，只有离开超过 64dp 才释放跟随', () => {
    // 微小离开 15dp、32dp、50dp、64dp 依然锁定跟随态
    expect(evaluateFollowState(0, true)).toBe(true);
    expect(evaluateFollowState(32, true)).toBe(true);
    expect(evaluateFollowState(50, true)).toBe(true);
    expect(evaluateFollowState(64, true)).toBe(true);

    // 离开超过 64dp（如 65dp、120dp），解除跟随
    expect(evaluateFollowState(65, true)).toBe(false);
    expect(evaluateFollowState(120, true)).toBe(false);
  });

  it('处于离底自由浏览态 (follow = false) 时，只有贴近到 32dp 以内才重新吸附', () => {
    // 距离较大 100dp、65dp、50dp、33dp 依然不吸附，保护用户自由阅读历史
    expect(evaluateFollowState(100, false)).toBe(false);
    expect(evaluateFollowState(50, false)).toBe(false);
    expect(evaluateFollowState(33, false)).toBe(false);

    // 贴近到 <= 32dp，重新吸底
    expect(evaluateFollowState(32, false)).toBe(true);
    expect(evaluateFollowState(10, false)).toBe(true);
    expect(evaluateFollowState(0, false)).toBe(true);
  });
});
