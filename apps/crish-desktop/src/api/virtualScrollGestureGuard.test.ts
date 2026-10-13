/**
 * apps/crish-desktop/src/api/virtualScrollGestureGuard.test.ts
 *
 * 长对话虚拟滚动 —— 惯性手势保护网与 100 行分桶混合虚拟化单元测试
 * 覆盖：
 * 1. Blink 原生布局跳过样式契约 (createHybridBucketCssStyle & contentVisibility: auto)
 * 2. 手势活跃期挂起与静止原子排空 (InertialGestureGuard settleWindow & atomic flush)
 * 3. 贴底模式 Anti-Jitter 熔断 (isPinnedToBottom circuit-breaker)
 * 4. 万级消息 100 行分桶混合虚拟化 (computeHybridBuckets activeBuckets <= 3)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  InertialGestureGuard,
  computeHybridBuckets,
  createHybridBucketCssStyle,
  DEFAULT_GESTURE_SETTLE_WINDOW_MS,
  DEFAULT_HYBRID_BUCKET_SIZE,
  DEFAULT_INTRINSIC_MESSAGE_HEIGHT_PX,
  MAX_ACTIVE_HYBRID_BUCKETS,
  HYBRID_BUCKET_CSS_STYLE,
  type HybridBucketInputItem,
  type MessageBucket,
} from './virtualScrollGestureGuard';

describe('virtualScrollGestureGuard', () => {
  describe('Blink 原生布局跳过样式契约 (createHybridBucketCssStyle)', () => {
    it('导出合法的系统默认常量与契约配置', () => {
      expect(DEFAULT_GESTURE_SETTLE_WINDOW_MS).toBe(120);
      expect(DEFAULT_HYBRID_BUCKET_SIZE).toBe(100);
      expect(DEFAULT_INTRINSIC_MESSAGE_HEIGHT_PX).toBe(72);
      expect(MAX_ACTIVE_HYBRID_BUCKETS).toBe(3);

      expect(HYBRID_BUCKET_CSS_STYLE).toEqual({
        contentVisibility: 'auto',
        containIntrinsicSize: 'auto 72px',
      });
      expect(Object.isFrozen(HYBRID_BUCKET_CSS_STYLE)).toBe(true);
    });

    it('默认参数下生成并复用标准 HYBRID_BUCKET_CSS_STYLE', () => {
      const style1 = createHybridBucketCssStyle();
      const style2 = createHybridBucketCssStyle(72);
      expect(style1).toBe(HYBRID_BUCKET_CSS_STYLE);
      expect(style2).toBe(HYBRID_BUCKET_CSS_STYLE);
      expect(style1.contentVisibility).toBe('auto');
      expect(style1.containIntrinsicSize).toBe('auto 72px');
    });

    it('支持自定义预估行高并返回冻结的 CSS 样式契约对象', () => {
      const style100 = createHybridBucketCssStyle(100);
      expect(style100).toEqual({
        contentVisibility: 'auto',
        containIntrinsicSize: 'auto 100px',
      });
      expect(Object.isFrozen(style100)).toBe(true);

      const styleFloat = createHybridBucketCssStyle(85.6);
      expect(styleFloat).toEqual({
        contentVisibility: 'auto',
        containIntrinsicSize: 'auto 86px',
      });
    });

    it('对非法/非有限/非正数值平稳降级至 72px 默认值', () => {
      expect(createHybridBucketCssStyle(0)).toBe(HYBRID_BUCKET_CSS_STYLE);
      expect(createHybridBucketCssStyle(-40)).toBe(HYBRID_BUCKET_CSS_STYLE);
      expect(createHybridBucketCssStyle(NaN)).toBe(HYBRID_BUCKET_CSS_STYLE);
      expect(createHybridBucketCssStyle(Infinity)).toBe(
        HYBRID_BUCKET_CSS_STYLE
      );
    });
  });

  describe('InertialGestureGuard: 手势活跃期挂起与静止原子排空', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('初始状态检测：手势非活跃，暂存增量与熔断计数均为 0', () => {
      const guard = new InertialGestureGuard();
      expect(guard.settleWindowMs).toBe(120);
      expect(guard.isPinnedToBottom).toBe(false);
      expect(guard.pendingHeightDelta).toBe(0);
      expect(guard.fusedCount).toBe(0);
      expect(guard.isGestureActive()).toBe(false);
    });

    it('手势非活跃时，测高增量即时生效并不发生挂起延迟', () => {
      const guard = new InertialGestureGuard();
      const decision = guard.recordHeightDelta(35);
      expect(decision).toEqual({
        immediateScrollDelta: 35,
        pendingHeightDelta: 0,
        fusedByPinnedBottom: false,
        deferredByGesture: false,
      });
      expect(guard.pendingHeightDelta).toBe(0);
    });

    it('手势活跃期内高度差挂起暂存，静止后单帧原子排空并重置为 0', () => {
      const onSettleFlush = vi.fn();
      const guard = new InertialGestureGuard({ onSettleFlush });

      // 1. 用户触发滚轮或触控板手势
      guard.markWheelOrTouchActivity();
      expect(guard.isGestureActive()).toBe(true);

      // 2. 在 120ms 静默窗口期内，高度差 queueHeightDelta(24) 被安全暂存入 pendingHeightDelta
      const queued = guard.queueHeightDelta(24);
      expect(queued).toBe(24);
      expect(guard.pendingHeightDelta).toBe(24);

      // 3. 此时 recordHeightDelta 也被挂起，不触发即时 scrollTop 强写
      const decision = guard.recordHeightDelta(16);
      expect(decision).toEqual({
        immediateScrollDelta: 0,
        pendingHeightDelta: 40,
        fusedByPinnedBottom: false,
        deferredByGesture: true,
      });
      expect(guard.pendingHeightDelta).toBe(40);

      // 4. enqueueHeightDelta 别名同样安全累加
      guard.enqueueHeightDelta(10);
      expect(guard.pendingHeightDelta).toBe(50);

      // 5. 手势活跃期间，常规 flushPendingDelta() 返回 0，不破坏手势平滑
      expect(guard.flushPendingDelta()).toBe(0);
      expect(guard.pendingHeightDelta).toBe(50);

      // 6. 超过 120ms 手势静止后，定时器触发原子排空并通知回调
      vi.advanceTimersByTime(125);
      expect(guard.isGestureActive()).toBe(false);
      expect(onSettleFlush).toHaveBeenCalledTimes(1);
      expect(onSettleFlush).toHaveBeenCalledWith(50);
      expect(guard.pendingHeightDelta).toBe(0);

      // 7. 手势已静止，flushPendingDelta() 返回 0
      expect(guard.flushPendingDelta()).toBe(0);
    });

    it('连续滚轮触发时顺延 120ms 静默窗口期', () => {
      const guard = new InertialGestureGuard();
      guard.markWheelOrTouchActivity();

      // 在 80ms 时再次触发手势
      vi.advanceTimersByTime(80);
      expect(guard.isGestureActive()).toBe(true);
      guard.markWheelOrTouchActivity();

      // 再过 80ms（距离首次 160ms，但距离第二次仅 80ms），手势依然活跃
      vi.advanceTimersByTime(80);
      expect(guard.isGestureActive()).toBe(true);

      // 再过 45ms（距离第二次 125ms），手势静止
      vi.advanceTimersByTime(45);
      expect(guard.isGestureActive()).toBe(false);
    });

    it('支持显式 force 强制排空活跃状态下的 pendingHeightDelta', () => {
      const guard = new InertialGestureGuard();
      guard.markWheelOrTouchActivity();
      guard.queueHeightDelta(30);

      expect(guard.isGestureActive()).toBe(true);
      // force 排空
      const flushed = guard.flushPendingDelta({ force: true });
      expect(flushed).toBe(30);
      expect(guard.pendingHeightDelta).toBe(0);
      expect(guard.isGestureActive()).toBe(false);
    });

    it('支持显式时间戳参数校验静默窗口期', () => {
      const virtualTime = 1000;
      const guard = new InertialGestureGuard({
        now: () => virtualTime,
      });

      guard.markWheelOrTouchActivity(1000);
      expect(guard.isGestureActive(1050)).toBe(true);
      expect(guard.isGestureActive(1119)).toBe(true);
      expect(guard.isGestureActive(1120)).toBe(false);
    });

    it('reset() 清空定时器与暂存状态', () => {
      const guard = new InertialGestureGuard();
      guard.markWheelOrTouchActivity();
      guard.queueHeightDelta(80);

      guard.reset();
      expect(guard.isGestureActive()).toBe(false);
      expect(guard.pendingHeightDelta).toBe(0);
    });
  });

  describe('贴底模式 Anti-Jitter 熔断', () => {
    it('当 isPinnedToBottom === true 时，queueHeightDelta(-50) 向上反向位移补偿被显式熔断忽略，返回 0', () => {
      const guard = new InertialGestureGuard({ isPinnedToBottom: true });
      expect(guard.isPinnedToBottom).toBe(true);

      const res = guard.queueHeightDelta(-50);
      expect(res).toBe(0);
      expect(guard.pendingHeightDelta).toBe(0);
      expect(guard.fusedCount).toBe(1);

      // enqueueHeightDelta 同样返回 0 并递增 fusedCount
      const res2 = guard.enqueueHeightDelta(-20);
      expect(res2).toBe(0);
      expect(guard.pendingHeightDelta).toBe(0);
      expect(guard.fusedCount).toBe(2);
    });

    it('贴底模式下 recordHeightDelta 返回 fusedByPinnedBottom 且 immediateScrollDelta 为 0', () => {
      const guard = new InertialGestureGuard({ isPinnedToBottom: true });

      const decision = guard.recordHeightDelta(40);
      expect(decision).toEqual({
        immediateScrollDelta: 0,
        pendingHeightDelta: 0,
        fusedByPinnedBottom: true,
        deferredByGesture: false,
      });
      expect(guard.fusedCount).toBe(1);

      // 增量为 0 时不递增 fusedCount
      const decisionZero = guard.recordHeightDelta(0);
      expect(decisionZero.fusedByPinnedBottom).toBe(true);
      expect(guard.fusedCount).toBe(1);
    });

    it('动态进入贴底态时，立即熔断清空已有的 pendingHeightDelta', () => {
      const guard = new InertialGestureGuard({ isPinnedToBottom: false });
      guard.markWheelOrTouchActivity();
      guard.queueHeightDelta(64);
      expect(guard.pendingHeightDelta).toBe(64);
      expect(guard.fusedCount).toBe(0);

      // 动态吸底
      guard.setPinnedToBottom(true);
      expect(guard.isPinnedToBottom).toBe(true);
      expect(guard.pendingHeightDelta).toBe(0);
      expect(guard.fusedCount).toBe(1);

      // 贴底态下 flushPendingDelta 返回 0
      expect(guard.flushPendingDelta()).toBe(0);
    });

    it('退出贴底态后恢复正常的增量累加与手势判定', () => {
      const guard = new InertialGestureGuard({ isPinnedToBottom: true });
      expect(guard.queueHeightDelta(30)).toBe(0);

      guard.setPinnedToBottom(false);
      expect(guard.isPinnedToBottom).toBe(false);

      guard.markWheelOrTouchActivity();
      expect(guard.queueHeightDelta(30)).toBe(30);
      expect(guard.pendingHeightDelta).toBe(30);
    });
  });

  describe('万级消息 100 行分桶混合虚拟化 (computeHybridBuckets)', () => {
    // 生成 10,000 条消息输入
    const TEN_THOUSAND = 10_000;
    const mockMessages: string[] = Array.from(
      { length: TEN_THOUSAND },
      (_, i) => `msg_${i}`
    );

    it('10,000 条消息输入精确划分为 100 个 MessageBucket，每个桶容量严格为 100', () => {
      const result = computeHybridBuckets(mockMessages, 0, 600);

      expect(result.length).toBe(100);
      expect(result.buckets.length).toBe(100);
      expect(result.bucketSize).toBe(100);
      expect(result.totalEstimatedHeight).toBe(
        TEN_THOUSAND * DEFAULT_INTRINSIC_MESSAGE_HEIGHT_PX
      );

      // 校验首桶、中间桶和末尾桶的区间索引与消息内容
      const firstBucket = result[0];
      expect(firstBucket.bucketIndex).toBe(0);
      expect(firstBucket.startIndex).toBe(0);
      expect(firstBucket.endIndex).toBe(100);
      expect(firstBucket.messageIds.length).toBe(100);
      expect(firstBucket.messageIds[0]).toBe('msg_0');
      expect(firstBucket.messageIds[99]).toBe('msg_99');
      expect(firstBucket.offsetTop).toBe(0);
      expect(firstBucket.estimatedHeight).toBe(100 * 72);

      const midBucket = result[50];
      expect(midBucket.bucketIndex).toBe(50);
      expect(midBucket.startIndex).toBe(5000);
      expect(midBucket.endIndex).toBe(5100);
      expect(midBucket.messageIds[0]).toBe('msg_5000');
      expect(midBucket.offsetTop).toBe(5000 * 72);
      expect(midBucket.estimatedHeight).toBe(100 * 72);

      const lastBucket = result[99];
      expect(lastBucket.bucketIndex).toBe(99);
      expect(lastBucket.startIndex).toBe(9900);
      expect(lastBucket.endIndex).toBe(10000);
      expect(lastBucket.messageIds[99]).toBe('msg_9999');
      expect(lastBucket.offsetTop).toBe(9900 * 72);
    });

    it('顶部视口 (scrollTop = 0): activeBuckets 数量严格 <= 3 (激活第 0 桶与第 1 桶)', () => {
      const result = computeHybridBuckets(mockMessages, 0, 600);

      expect(result.currentBucketIndex).toBe(0);
      expect(result.activeBuckets.length).toBeLessThanOrEqual(
        MAX_ACTIVE_HYBRID_BUCKETS
      );
      expect(result.activeBuckets.length).toBe(2);
      expect(result.activeBucketIndices).toEqual([0, 1]);

      // 状态断言
      expect(result[0].isActive).toBe(true);
      expect(result[0].isCollapsedPlaceholder).toBe(false);
      expect(result[1].isActive).toBe(true);
      expect(result[1].isCollapsedPlaceholder).toBe(false);
      expect(result[2].isActive).toBe(false);
      expect(result[2].isCollapsedPlaceholder).toBe(true);
    });

    it('中间视口 (scrollTop = 360000): activeBuckets 数量严格 <= 3 (当前桶加前后相邻各 1 桶)', () => {
      // 360,000px 对应第 50 桶附近 (50 * 7200 = 360,000)
      const result = computeHybridBuckets(mockMessages, 360000, 600);

      expect(result.currentBucketIndex).toBe(50);
      expect(result.activeBuckets.length).toBeLessThanOrEqual(
        MAX_ACTIVE_HYBRID_BUCKETS
      );
      expect(result.activeBuckets.length).toBe(3);
      expect(result.activeBucketIndices).toEqual([49, 50, 51]);

      // 当前桶及其前后桶激活，其余折叠
      expect(result[48].isActive).toBe(false);
      expect(result[49].isActive).toBe(true);
      expect(result[50].isActive).toBe(true);
      expect(result[51].isActive).toBe(true);
      expect(result[52].isActive).toBe(false);
    });

    it('底部视口 (scrollTop = 720000): activeBuckets 数量严格 <= 3 (激活末尾两桶 98, 99)', () => {
      const totalH = TEN_THOUSAND * 72;
      const result = computeHybridBuckets(mockMessages, totalH, 600);

      expect(result.currentBucketIndex).toBe(99);
      expect(result.activeBuckets.length).toBeLessThanOrEqual(
        MAX_ACTIVE_HYBRID_BUCKETS
      );
      expect(result.activeBuckets.length).toBe(2);
      expect(result.activeBucketIndices).toEqual([98, 99]);

      expect(result[97].isActive).toBe(false);
      expect(result[98].isActive).toBe(true);
      expect(result[99].isActive).toBe(true);
    });

    it('全量随机视口滚动偏移下，activeBuckets 数量均恒定 <= 3 且 >= 1', () => {
      const testScrollTops = [
        0, 100, 7199, 7200, 7201, 14400, 50000, 100000, 200000, 360000, 500000,
        650000, 700000, 719000, 719400, 720000, 1000000,
      ];

      for (const st of testScrollTops) {
        const res = computeHybridBuckets(mockMessages, st, 600);
        expect(res.activeBuckets.length).toBeLessThanOrEqual(
          MAX_ACTIVE_HYBRID_BUCKETS
        );
        expect(res.activeBuckets.length).toBeGreaterThanOrEqual(1);
        expect(res.activeBuckets.length).toBe(res.activeBucketIndices.length);
      }
    });

    it('支持结构化对象输入与 getItemHeight 自定义测高计算', () => {
      const structItems: HybridBucketInputItem[] = Array.from(
        { length: 250 },
        (_, i) => ({
          id: `card_${i}`,
          estimatedHeight: i % 2 === 0 ? 100 : 50,
        })
      );

      const res = computeHybridBuckets({
        messages: structItems,
        bucketSize: 50,
        scrollTop: 0,
        viewportHeight: 500,
      });

      expect(res.buckets.length).toBe(5);
      // 50 * ((100 + 50) / 2) = 50 * 75 = 3750
      expect(res[0].estimatedHeight).toBe(3750);
      expect(res[0].messageIds[0]).toBe('card_0');
      expect(res.activeBucketIndices).toEqual([0, 1]);
    });

    it('边界情况保护：空消息列表返回空分桶与安全默认态', () => {
      const res = computeHybridBuckets([], 0, 600);
      expect(res.length).toBe(0);
      expect(res.buckets.length).toBe(0);
      expect(res.activeBuckets.length).toBe(0);
      expect(res.activeBucketIndices.length).toBe(0);
      expect(res.currentBucketIndex).toBe(-1);
      expect(res.totalEstimatedHeight).toBe(0);
    });

    it('单桶少于 100 条消息时，仅生成 1 个桶且为唯一活跃桶', () => {
      const res = computeHybridBuckets(['m1', 'm2', 'm3'], 0, 600);
      expect(res.length).toBe(1);
      expect(res.currentBucketIndex).toBe(0);
      expect(res.activeBuckets.length).toBe(1);
      expect(res.activeBucketIndices).toEqual([0]);
      expect(res[0].messageIds).toEqual(['m1', 'm2', 'm3']);
    });
  });

  describe('[VS-U03] 硬件 Capture 拦截、代际计数与程序性滚动豁免撤销', () => {
    it('手势启动递增 gestureEpoch 并自动撤销 programmaticScrollExempt 令牌', () => {
      let now = 1000;
      const guard = new InertialGestureGuard({
        settleWindowMs: 120,
        now: () => now,
      });

      guard.markProgrammaticScroll();
      expect(guard.programmaticScrollExempt).toBe(true);
      expect(guard.gestureEpoch).toBe(0);

      guard.markWheelOrTouchActivity(now);
      expect(guard.isGestureActive(now)).toBe(true);
      expect(guard.programmaticScrollExempt).toBe(false);
      expect(guard.gestureEpoch).toBe(1);

      // 同一手势窗口内连续输入不重复递增 epoch
      now += 40;
      guard.markWheelOrTouchActivity(now);
      expect(guard.gestureEpoch).toBe(1);

      const dec1 = guard.recordHeightDelta(40, { timestampMs: now });
      expect(dec1.immediateScrollDelta).toBe(0);
      expect(dec1.pendingHeightDelta).toBe(40);
      expect(dec1.deferredByGesture).toBe(true);

      guard.setPinnedToBottom(true);
      expect(guard.pendingHeightDelta).toBe(0);
      expect(guard.fusedCount).toBe(1);

      now += 150;
      expect(guard.isGestureActive(now)).toBe(false);
      expect(guard.flushPendingDelta({ timestampMs: now })).toBe(0);
    });

    it('bindCaptureGestureListeners 以 Capture 模式拦截物理事件并支持干净解绑', () => {
      const guard = new InertialGestureGuard();
      const target = new EventTarget();
      const onInterrupt = vi.fn();

      const unbind = guard.bindCaptureGestureListeners(target, onInterrupt);
      target.dispatchEvent(new Event('wheel'));

      expect(guard.isGestureActive()).toBe(true);
      expect(onInterrupt).toHaveBeenCalledTimes(1);

      guard.reset();
      unbind();
      target.dispatchEvent(new Event('wheel'));
      expect(guard.isGestureActive()).toBe(false);
      expect(onInterrupt).toHaveBeenCalledTimes(1);
    });
  });
});
