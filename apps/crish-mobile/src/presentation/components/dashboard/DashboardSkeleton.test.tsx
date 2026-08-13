// DashboardSkeleton 组件测试（R2UX-05-10 首页首帧骨架 + R2UX-05-04 骨架屏条款）：
// - 三块结构：状态卡 / 快速操作 / 事件流（feed 行 ×N，行高对齐 EVENT_ROW_HEIGHT=56，
//   替换无高度跳变）；token 色（卡片底 bgCard + 块色 bgTertiary，M4 §8.1 三档背景）；
// - 微动画：默认（探测 false）启动 Animated.loop 脉冲；reduce-motion（prop 注入 /
//   系统探测 true）→ 静态不启动循环；运行中开启 → 即时停止（R2UX §4.4-1/4.4-2）；
// - 判据纯函数 dashboardShowSkeleton：缓存优先（有数据不骨架）、首拉中骨架、
//   连接稳定无数据 → 空态路径、数据到达 → 骨架让位（替换翻转不闪烁）。
import { AccessibilityInfo, Animated } from 'react-native';
import { act, render, screen } from '@testing-library/react-native';
import { lightTokens } from '@/adapters/platform/theme';
import { EVENT_ROW_HEIGHT } from '@/presentation/components/blocks/EventRow';
import {
  DashboardSkeleton,
  dashboardShowSkeleton,
  SKELETON_FEED_ROWS,
} from './DashboardSkeleton';

// ---------- 测试基建 ----------

/** 假 CompositeAnimation：记录 start/stop 调用（避免真实 loop 无限跑） */
function makeFakeAnimation() {
  const start = jest.fn();
  const stop = jest.fn();
  return { start, stop, reset: jest.fn() };
}

let loopSpy: jest.SpyInstance;
let fakeAnimation: ReturnType<typeof makeFakeAnimation>;
/** reduceMotionChanged 订阅回调（变化响应测试捕获） */
let motionListener: ((value: boolean) => void) | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  motionListener = null;
  fakeAnimation = makeFakeAnimation();
  loopSpy = jest
    .spyOn(Animated, 'loop')
    .mockReturnValue(fakeAnimation as unknown as Animated.CompositeAnimation);
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockResolvedValue(false);
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(((
    event: string,
    cb: (value: boolean) => void
  ) => {
    if (event === 'reduceMotionChanged') motionListener = cb;
    return { remove: jest.fn() };
  }) as never);
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** 刷新 isReduceMotionEnabled 探测 promise（setState 在 act 内落地） */
async function flushMotionProbe() {
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * 骨架为装饰性占位（对辅助技术隐藏，no-hide-descendants）→ TLRN v14 默认查询
 * 视为隐藏元素；查询须显式 includeHiddenElements: true（v14 语义）。
 */
function q(testId: string) {
  return screen.getByTestId(testId, { includeHiddenElements: true });
}

// ---------- 三块结构与 token 色 ----------

describe('骨架三块结构（R2UX-05-10）', () => {
  it('渲染状态卡 / 快速操作 / 事件流三块', async () => {
    await render(<DashboardSkeleton reduceMotion />);
    expect(q('dashboard-skeleton')).toBeTruthy();
    expect(q('skeleton-status-card')).toBeTruthy();
    expect(q('skeleton-quickrun')).toBeTruthy();
    expect(q('skeleton-event-feed')).toBeTruthy();
  });

  it('事件流骨架：过滤条 3 胶囊 + SKELETON_FEED_ROWS 行（行高对齐 EVENT_ROW_HEIGHT）', async () => {
    await render(<DashboardSkeleton reduceMotion />);
    expect(q('skeleton-feed-filter-0')).toBeTruthy();
    expect(q('skeleton-feed-filter-2')).toBeTruthy();
    for (let i = 0; i < SKELETON_FEED_ROWS; i++) {
      expect(q(`skeleton-feed-row-${i}`)).toHaveStyle({
        height: EVENT_ROW_HEIGHT,
      });
    }
    expect(
      screen.queryByTestId(`skeleton-feed-row-${SKELETON_FEED_ROWS}`)
    ).toBeNull();
  });

  it('token 色：卡片底 bgCard、块色 bgTertiary（M4 §8.1 三档背景，无硬编码）', async () => {
    await render(<DashboardSkeleton reduceMotion />);
    expect(q('skeleton-status-card')).toHaveStyle({
      backgroundColor: lightTokens.bgCard,
    });
    expect(q('skeleton-status-title')).toHaveStyle({
      backgroundColor: lightTokens.bgTertiary,
    });
    expect(q('skeleton-quickrun-input')).toHaveStyle({
      backgroundColor: lightTokens.bgTertiary,
    });
    expect(q('skeleton-feed-summary-0')).toHaveStyle({
      backgroundColor: lightTokens.bgTertiary,
    });
  });

  it('快速操作骨架尺寸对齐 QuickRunPanel（输入行 44 / 按钮 92 胶囊）', async () => {
    await render(<DashboardSkeleton reduceMotion />);
    expect(q('skeleton-quickrun-input')).toHaveStyle({
      height: 44,
      borderRadius: 10,
    });
    expect(q('skeleton-quickrun-submit')).toHaveStyle({
      width: 92,
      height: 44,
      borderRadius: 9999,
    });
  });
});

// ---------- reduce-motion 降级（R2UX §4.4） ----------

describe('骨架呼吸动画与 reduce-motion 降级（R2UX-05-04 / §4.4）', () => {
  it('默认（系统未开 reduce-motion）：启动 Animated.loop 脉冲', async () => {
    await render(<DashboardSkeleton />);
    await flushMotionProbe();
    expect(loopSpy).toHaveBeenCalled();
    expect(fakeAnimation.start).toHaveBeenCalled();
  });

  it('reduceMotion prop 注入：静态不启动循环', async () => {
    await render(<DashboardSkeleton reduceMotion />);
    await flushMotionProbe();
    expect(loopSpy).not.toHaveBeenCalled();
    expect(fakeAnimation.start).not.toHaveBeenCalled();
  });

  it('系统探测开启 reduce-motion：静态不启动循环', async () => {
    (
      AccessibilityInfo.isReduceMotionEnabled as jest.Mock
    ).mockResolvedValueOnce(true);
    await render(<DashboardSkeleton />);
    await flushMotionProbe();
    expect(loopSpy).not.toHaveBeenCalled();
  });

  it('运行中收到 reduceMotionChanged(true)：即时停止循环（变化即时响应）', async () => {
    await render(<DashboardSkeleton />);
    await flushMotionProbe();
    expect(fakeAnimation.start).toHaveBeenCalled();
    await act(async () => {
      motionListener?.(true);
    });
    expect(fakeAnimation.stop).toHaveBeenCalled();
  });

  it('骨架为装饰性占位：对辅助技术隐藏', async () => {
    await render(<DashboardSkeleton reduceMotion />);
    const skeleton = q('dashboard-skeleton');
    expect(skeleton.props.accessibilityElementsHidden).toBe(true);
    expect(skeleton.props.importantForAccessibility).toBe(
      'no-hide-descendants'
    );
  });
});

// ---------- 接线判据纯函数（缓存优先 / 首拉骨架 / 数据到达替换） ----------

describe('dashboardShowSkeleton（R2UX-05-10 缓存优先接线判据）', () => {
  it('缓存优先：有会话 → 任何相位都不显示骨架（已水合数据立即可见）', () => {
    for (const phase of [
      'disconnected',
      'connecting',
      'ready',
      'recovering',
      'offline',
    ] as const) {
      expect(dashboardShowSkeleton(phase, 's-1', 0)).toBe(false);
    }
  });

  it('缓存优先：eventStore 已有窗口条目 → 不显示骨架（feed 缓存直接渲染）', () => {
    expect(dashboardShowSkeleton('connecting', null, 3)).toBe(false);
    expect(dashboardShowSkeleton('disconnected', null, 1)).toBe(false);
  });

  it('无数据且连接未稳定（disconnected/connecting = 水合/首拉中）→ 骨架', () => {
    expect(dashboardShowSkeleton('disconnected', null, 0)).toBe(true);
    expect(dashboardShowSkeleton('connecting', null, 0)).toBe(true);
  });

  it('无数据且连接已稳定（ready/recovering/offline）→ 空态路径不骨架', () => {
    expect(dashboardShowSkeleton('ready', null, 0)).toBe(false);
    expect(dashboardShowSkeleton('recovering', null, 0)).toBe(false);
    expect(dashboardShowSkeleton('offline', null, 0)).toBe(false);
  });

  it('数据到达 → 骨架让位（true → false 翻转，同布局尺寸替换不闪烁）', () => {
    // 首帧：无会话、连接建立中 → 骨架
    expect(dashboardShowSkeleton('connecting', null, 0)).toBe(true);
    // 数据到达（会话水合 / feed 条目落窗）→ 骨架立即让位
    expect(dashboardShowSkeleton('connecting', 's-1', 0)).toBe(false);
    expect(dashboardShowSkeleton('ready', null, 2)).toBe(false);
  });
});
