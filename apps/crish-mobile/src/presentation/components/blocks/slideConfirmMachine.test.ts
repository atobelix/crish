// L2 滑动确认状态机纯函数测试（F2 §5.3 阈值 70% / R2UX §2.1 仲裁 / §2.4-3 回弹防误触）：
// - 阈值边界（69% 不触发回弹 / 70% 恰好触发 / 100% 抬起触发）、回弹、busy 锁定、水平仲裁全量覆盖；
// - 进度按「可滑动距离 = 轨道宽 - 滑块 44」归一化（slideUsableWidth），越界 clamp；
// - locked 语义：事件幂等返回原状态（同一引用），组件据此跳过无效 setState。
import {
  SLIDE_ARBITER_MIN_DX,
  SLIDE_ARBITER_RATIO,
  SLIDE_REBOUND_MS,
  SLIDE_THUMB_SIZE,
  SLIDE_TRIGGER_THRESHOLD,
  createSlideConfirmState,
  shouldClaimSlidePan,
  slideCancel,
  slideEnd,
  slideMove,
  slideStart,
  slideUsableWidth,
} from './slideConfirmMachine';

// 标准轨道 300（usable = 256）；精确 70% 边界轨道 1044（usable = 1000，dx=700 恰为 0.7）
const TRACK_300 = 300;
const TRACK_EXACT = SLIDE_THUMB_SIZE + 1000; // 1044
const USABLE_300 = 256;

describe('slideConfirmMachine 常量（绑定 F2 / R2UX 数值）', () => {
  it('阈值 70% / 仲裁 12dp×1.2 / 滑块 44 / 回弹 200ms', () => {
    expect(SLIDE_TRIGGER_THRESHOLD).toBe(0.7);
    expect(SLIDE_ARBITER_MIN_DX).toBe(12);
    expect(SLIDE_ARBITER_RATIO).toBe(1.2);
    expect(SLIDE_THUMB_SIZE).toBe(44);
    expect(SLIDE_REBOUND_MS).toBe(200);
  });
});

describe('slideConfirmMachine 初始状态与可滑动距离', () => {
  it('初始 idle / progress 0', () => {
    expect(createSlideConfirmState()).toEqual({
      phase: 'idle',
      progress: 0,
    });
  });

  it('slideUsableWidth：轨道宽 - 滑块宽；未测量（0）与不足（<44）返回 0', () => {
    expect(slideUsableWidth(TRACK_300)).toBe(USABLE_300);
    expect(slideUsableWidth(0)).toBe(0);
    expect(slideUsableWidth(20)).toBe(0);
    expect(slideUsableWidth(300, 20)).toBe(280);
  });
});

describe('slideConfirmMachine 水平位移优先仲裁（R2UX §2.1）', () => {
  it('横向位移 > 12dp 且 > 纵向 ×1.2 才劫持触摸（双向判定）', () => {
    expect(shouldClaimSlidePan(13, 2)).toBe(true);
    expect(shouldClaimSlidePan(-13, 0)).toBe(true);
    expect(shouldClaimSlidePan(50, 40)).toBe(true); // 50 > 48
  });

  it('未过 12dp 或纵向占比高时不劫持', () => {
    expect(shouldClaimSlidePan(12, 2)).toBe(false); // 等于阈值不劫持
    expect(shouldClaimSlidePan(11, 2)).toBe(false);
    expect(shouldClaimSlidePan(0, 0)).toBe(false);
    expect(shouldClaimSlidePan(50, 42)).toBe(false); // 50 < 50.4
    expect(shouldClaimSlidePan(50, 50)).toBe(false); // 斜向均等 → 不劫持
    expect(shouldClaimSlidePan(3, 30)).toBe(false);
  });

  it('支持自定义 minDx / ratio（可注入覆盖）', () => {
    expect(shouldClaimSlidePan(20, 2, 10, 8)).toBe(true); // 20 > 16
    expect(shouldClaimSlidePan(20, 2, 10, 11)).toBe(false); // 20 < 22
  });
});

describe('slideConfirmMachine 拖动状态迁移', () => {
  it('slideStart：idle → dragging 进度归零；locked 忽略', () => {
    const idle = createSlideConfirmState();
    const dragging = slideStart(idle);
    expect(dragging).toEqual({ phase: 'dragging', progress: 0 });

    const armed = { phase: 'armed' as const, progress: 0.8 };
    expect(slideStart(armed)).toEqual({ phase: 'dragging', progress: 0 });

    const locked = slideStart(idle, true);
    expect(locked).toBe(idle);
  });

  it('slideMove：dx 归一化为进度（半程 50%）', () => {
    const dragging = slideStart(createSlideConfirmState());
    const half = slideMove(dragging, 128, TRACK_300);
    expect(half).toEqual({ phase: 'dragging', progress: 0.5 });
  });

  it('slideMove：负值 clamp 0、超界 clamp 1（100%）', () => {
    const dragging = slideStart(createSlideConfirmState());
    expect(slideMove(dragging, -50, TRACK_300).progress).toBe(0);
    expect(slideMove(dragging, 999, TRACK_300)).toEqual({
      phase: 'armed',
      progress: 1,
    });
  });

  it('slideMove：69% 与 70% 精确边界（usable=1000）', () => {
    const dragging = slideStart(createSlideConfirmState());
    expect(slideMove(dragging, 699, TRACK_EXACT)).toEqual({
      phase: 'dragging',
      progress: 0.699,
    });
    expect(slideMove(dragging, 700, TRACK_EXACT)).toEqual({
      phase: 'armed',
      progress: 0.7,
    });
  });

  it('slideMove：标准轨道边界（dx=179 → 69.9% / dx=180 → 70.3%）', () => {
    const dragging = slideStart(createSlideConfirmState());
    expect(slideMove(dragging, 179, TRACK_300).phase).toBe('dragging');
    expect(slideMove(dragging, 180, TRACK_300).phase).toBe('armed');
  });

  it('slideMove：回撤过阈值后重新落到 70% 以下 → 退回 dragging', () => {
    const armed = { phase: 'armed' as const, progress: 0.8 };
    const back = slideMove(armed, 26, TRACK_300); // 26/256 ≈ 0.1
    expect(back).toEqual({ phase: 'dragging', progress: 26 / 256 });
  });

  it('slideMove：locked / idle / triggered 幂等返回原引用', () => {
    const idle = createSlideConfirmState();
    expect(slideMove(idle, 100, TRACK_300)).toBe(idle);

    const triggered = { phase: 'triggered' as const, progress: 1 };
    expect(slideMove(triggered, 100, TRACK_300)).toBe(triggered);

    const dragging = slideStart(createSlideConfirmState());
    expect(slideMove(dragging, 100, TRACK_300, true)).toBe(dragging);
  });

  it('slideMove：轨道未测量（width 0）→ 进度 0 不 armed', () => {
    const dragging = slideStart(createSlideConfirmState());
    expect(slideMove(dragging, 200, 0)).toEqual({
      phase: 'dragging',
      progress: 0,
    });
  });
});

describe('slideConfirmMachine 抬起触发与回弹（F2 §5.3）', () => {
  it('未达阈值抬起（69%）→ 回弹：不触发、idle、progress 0', () => {
    const dragging = slideMove(
      slideStart(createSlideConfirmState()),
      699,
      TRACK_EXACT
    );
    expect(dragging.phase).toBe('dragging');
    const result = slideEnd(dragging);
    expect(result.triggered).toBe(false);
    expect(result.state).toEqual({ phase: 'idle', progress: 0 });
  });

  it('恰好 70% 抬起 → 触发（triggered，progress 1）', () => {
    const armed = slideMove(
      slideStart(createSlideConfirmState()),
      700,
      TRACK_EXACT
    );
    expect(armed.phase).toBe('armed');
    const result = slideEnd(armed);
    expect(result.triggered).toBe(true);
    expect(result.state).toEqual({ phase: 'triggered', progress: 1 });
  });

  it('100% 进度抬起 → 触发（「抬起触发」语义：拖动到 100% 本身不触发）', () => {
    const full = slideMove(
      slideStart(createSlideConfirmState()),
      999,
      TRACK_300
    );
    expect(full.progress).toBe(1);
    // 拖动中（未抬起）不触发
    expect(full.phase).toBe('armed');
    const result = slideEnd(full);
    expect(result.triggered).toBe(true);
    expect(result.state.phase).toBe('triggered');
  });

  it('标准轨道：179/256（69.9%）不触发，180/256（70.3%）触发', () => {
    const below = slideMove(
      slideStart(createSlideConfirmState()),
      179,
      TRACK_300
    );
    expect(slideEnd(below).triggered).toBe(false);
    const above = slideMove(
      slideStart(createSlideConfirmState()),
      180,
      TRACK_300
    );
    expect(slideEnd(above).triggered).toBe(true);
  });

  it('半程抬起（50%）→ 回弹不触发', () => {
    const half = slideMove(
      slideStart(createSlideConfirmState()),
      128,
      TRACK_300
    );
    const result = slideEnd(half);
    expect(result.triggered).toBe(false);
    expect(result.state).toEqual({ phase: 'idle', progress: 0 });
  });

  it('locked 期间抬起 → 幂等不触发（busy 锁定）', () => {
    const armed = { phase: 'armed' as const, progress: 0.9 };
    const result = slideEnd(armed, true);
    expect(result.triggered).toBe(false);
    expect(result.state).toBe(armed);
  });

  it('idle / triggered 状态抬起 → 幂等不触发', () => {
    const idle = createSlideConfirmState();
    expect(slideEnd(idle)).toEqual({ state: idle, triggered: false });

    const triggered = { phase: 'triggered' as const, progress: 1 };
    expect(slideEnd(triggered)).toEqual({ state: triggered, triggered: false });
  });
});

describe('slideConfirmMachine 手势终止（terminate）', () => {
  it('拖动中终止 → 回弹回 idle', () => {
    const dragging = slideMove(
      slideStart(createSlideConfirmState()),
      128,
      TRACK_300
    );
    expect(slideCancel(dragging)).toEqual({ phase: 'idle', progress: 0 });
  });

  it('armed 中终止 → 回弹回 idle（不触发）', () => {
    const armed = { phase: 'armed' as const, progress: 0.9 };
    expect(slideCancel(armed)).toEqual({ phase: 'idle', progress: 0 });
  });

  it('locked 期间终止 → 忽略（原引用）', () => {
    const dragging = slideStart(createSlideConfirmState());
    expect(slideCancel(dragging, true)).toBe(dragging);
  });
});
