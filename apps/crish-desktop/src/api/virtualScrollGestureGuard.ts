/**
 * apps/crish-desktop/src/api/virtualScrollGestureGuard.ts
 *
 * 长对话虚拟滚动 —— 惯性手势保护网 (Inertial Gesture Protection Network)
 * 与 Blink `content-visibility: auto` + 100 行分桶混合虚拟化计算器 (Hybrid-Native Bucket Virtualizer)。
 */

import {
  normalizeNonNegFloat,
  normalizeNonNegInt,
  normalizePositiveFloat,
} from './virtualScrollEstimate';

/** 默认手势静默判定窗口（毫秒） */
export const DEFAULT_GESTURE_SETTLE_WINDOW_MS = 120;
/** 默认混合虚拟化分桶容量（每桶消息条数） */
export const DEFAULT_HYBRID_BUCKET_SIZE = 100;
/** 默认单条消息 CSS contain-intrinsic-size 预估高度（像素） */
export const DEFAULT_INTRINSIC_MESSAGE_HEIGHT_PX = 72;
/** 任意视口位置允许同时挂载的最大活跃分桶数（当前桶 + 前后相邻各 1 桶） */
export const MAX_ACTIVE_HYBRID_BUCKETS = 3;

/** 标准 Blink 原生布局跳过样式契约 */
export interface HybridBucketCssStyle {
  readonly contentVisibility: 'auto';
  readonly containIntrinsicSize: string;
}

export const HYBRID_BUCKET_CSS_STYLE: HybridBucketCssStyle = Object.freeze({
  contentVisibility: 'auto',
  containIntrinsicSize: `auto ${DEFAULT_INTRINSIC_MESSAGE_HEIGHT_PX}px`,
});

/** 根据指定预估行高生成原生 `content-visibility: auto` 样式契约 */
export function createHybridBucketCssStyle(
  intrinsicPx: number = DEFAULT_INTRINSIC_MESSAGE_HEIGHT_PX
): HybridBucketCssStyle {
  const px = Math.round(normalizePositiveFloat(intrinsicPx, 72));
  return px === DEFAULT_INTRINSIC_MESSAGE_HEIGHT_PX
    ? HYBRID_BUCKET_CSS_STYLE
    : Object.freeze({
        contentVisibility: 'auto',
        containIntrinsicSize: `auto ${px}px`,
      });
}

export interface InertialGestureGuardOptions {
  readonly settleWindowMs?: number;
  readonly isPinnedToBottom?: boolean;
  readonly now?: () => number;
  readonly onSettleFlush?: (flushedDelta: number) => void;
}

export interface GestureGuardOperationOptions {
  readonly isPinnedToBottom?: boolean;
  readonly timestampMs?: number;
  readonly force?: boolean;
}

export interface GestureDeltaDecision {
  readonly immediateScrollDelta: number;
  readonly pendingHeightDelta: number;
  readonly fusedByPinnedBottom: boolean;
  readonly deferredByGesture: boolean;
}

const defaultNow = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

const toDecision = (
  immediateScrollDelta: number,
  pendingHeightDelta: number,
  fusedByPinnedBottom: boolean,
  deferredByGesture: boolean
): GestureDeltaDecision => ({
  immediateScrollDelta,
  pendingHeightDelta,
  fusedByPinnedBottom,
  deferredByGesture,
});

/**
 * 惯性手势保护网状态机 (`InertialGestureGuard`)。
 */
export class InertialGestureGuard {
  public readonly settleWindowMs: number;
  public isPinnedToBottom: boolean;
  public pendingHeightDelta = 0;
  public fusedCount = 0;
  private readonly nowFn: () => number;
  private readonly onSettleFlush?: (flushedDelta: number) => void;
  private _gestureActive = false;
  private _lastExplicitTs: number | null = null;
  private _lastClockTs: number | null = null;
  private _settleTimerId: ReturnType<typeof setTimeout> | null = null;

  constructor(options: InertialGestureGuardOptions = {}) {
    this.settleWindowMs = normalizePositiveFloat(
      options.settleWindowMs ?? 120,
      120
    );
    this.isPinnedToBottom = Boolean(options.isPinnedToBottom);
    this.nowFn = options.now ?? defaultNow;
    this.onSettleFlush = options.onSettleFlush;
  }

  /** 更新贴底状态；进入贴底态时立即触发 Anti-Jitter 熔断并清零挂起补偿 */
  public setPinnedToBottom(pinned: boolean): void {
    this.isPinnedToBottom = Boolean(pinned);
    if (this.isPinnedToBottom && this.pendingHeightDelta !== 0) {
      this.fusePending(true);
    }
  }

  /** 记录滚轮或触控板滑动活跃状态，开启或顺延 `settleWindowMs` 静默保护窗口 */
  public markWheelOrTouchActivity(timestampMs?: number): void {
    const clockNow = this.nowFn();
    const hasExplicit =
      typeof timestampMs === 'number' && Number.isFinite(timestampMs);
    this._lastExplicitTs = hasExplicit ? timestampMs : clockNow;
    this._lastClockTs = clockNow;
    this._gestureActive = true;

    this.clearSettleTimer();
    this._settleTimerId = setTimeout(() => {
      this._settleTimerId = null;
      this._gestureActive = false;
      this.onSettleFlush?.(this.flushPendingDelta({ force: true }));
    }, this.settleWindowMs);
  }

  /** 判定当前是否处于滚轮/触控板手势活跃窗口内 */
  public isGestureActive(timestampMs?: number): boolean {
    if (!this._gestureActive) return false;
    const hasExplicit =
      typeof timestampMs === 'number' && Number.isFinite(timestampMs);
    const currentTs = hasExplicit ? timestampMs : this.nowFn();
    const baseTs =
      (hasExplicit ? this._lastExplicitTs : this._lastClockTs) ?? currentTs;
    if (currentTs - baseTs >= this.settleWindowMs) {
      this._gestureActive = false;
      this.clearSettleTimer();
      return false;
    }
    return true;
  }

  /** 接收异步测高产生的 `heightDelta`，执行贴底熔断与手势静默暂存裁决 */
  public recordHeightDelta(
    heightDelta: number,
    opts?: GestureGuardOperationOptions | boolean
  ): GestureDeltaDecision {
    const parsed = this.syncOptions(opts);
    const safeDelta = Number.isFinite(heightDelta) ? heightDelta : 0;

    if (this.isPinnedToBottom) {
      this.fusePending(safeDelta !== 0 || this.pendingHeightDelta !== 0);
      return toDecision(0, 0, true, false);
    }

    const active = this.isGestureActive(parsed.timestampMs);
    if (safeDelta === 0)
      return toDecision(0, this.pendingHeightDelta, false, active);
    if (active) {
      this.pendingHeightDelta += safeDelta;
      return toDecision(0, this.pendingHeightDelta, false, true);
    }

    const immediate = this.pendingHeightDelta + safeDelta;
    this.pendingHeightDelta = 0;
    return toDecision(immediate, 0, false, false);
  }

  /** 将高度差直接暂存累加至内部静默队列（贴底态下显式熔断归零） */
  public enqueueHeightDelta(
    heightDelta: number,
    opts?: GestureGuardOperationOptions | boolean
  ): number {
    this.syncOptions(opts);
    if (this.isPinnedToBottom) return this.fusePending(true);
    if (Number.isFinite(heightDelta)) this.pendingHeightDelta += heightDelta;
    return this.pendingHeightDelta;
  }

  /** queueHeightDelta 别名方法，提供完全一致的暂存语义 */
  public queueHeightDelta(
    heightDelta: number,
    opts?: GestureGuardOperationOptions | boolean
  ): number {
    return this.enqueueHeightDelta(heightDelta, opts);
  }

  /** 手势静止到期后单帧原子排空，一次性返回累计补偿量并清零 */
  public flushPendingDelta(
    optsOrTs?: number | GestureGuardOperationOptions
  ): number {
    const opts =
      typeof optsOrTs === 'number'
        ? { timestampMs: optsOrTs }
        : (optsOrTs ?? {});
    if (this.isPinnedToBottom)
      return this.fusePending(this.pendingHeightDelta !== 0);
    if (!opts.force && this.isGestureActive(opts.timestampMs)) return 0;

    this._gestureActive = false;
    this.clearSettleTimer();
    const flushed = this.pendingHeightDelta;
    this.pendingHeightDelta = 0;
    return flushed;
  }

  public reset(): void {
    this.clearSettleTimer();
    this._gestureActive = false;
    this.pendingHeightDelta = 0;
    this._lastExplicitTs = this._lastClockTs = null;
  }

  private fusePending(count: boolean): 0 {
    if (count) this.fusedCount += 1;
    return (this.pendingHeightDelta = 0);
  }

  private syncOptions(
    opts?: GestureGuardOperationOptions | boolean
  ): GestureGuardOperationOptions {
    const res =
      typeof opts === 'boolean' ? { isPinnedToBottom: opts } : (opts ?? {});
    if (res.isPinnedToBottom !== undefined)
      this.setPinnedToBottom(res.isPinnedToBottom);
    return res;
  }

  private clearSettleTimer(): void {
    if (this._settleTimerId !== null) clearTimeout(this._settleTimerId);
    this._settleTimerId = null;
  }
}

export type HybridBucketInputItem =
  string | { readonly id: string; readonly estimatedHeight?: number };

export interface MessageBucket {
  readonly bucketIndex: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly messageIds: readonly string[];
  readonly estimatedHeight: number;
  readonly offsetTop: number;
  readonly isActive: boolean;
  readonly isCollapsedPlaceholder: boolean;
  readonly cssStyle: HybridBucketCssStyle;
}

export interface ComputeHybridBucketsOptions {
  readonly messages?: readonly HybridBucketInputItem[];
  readonly messageIds?: readonly string[];
  readonly scrollTop?: number;
  readonly viewportHeight?: number;
  readonly bucketSize?: number;
  readonly defaultItemHeight?: number;
  readonly getItemHeight?: (id: string, index: number) => number;
}

export interface HybridBucketComputationResult extends ReadonlyArray<MessageBucket> {
  readonly buckets: readonly MessageBucket[];
  readonly activeBuckets: readonly MessageBucket[];
  readonly activeBucketIndices: readonly number[];
  readonly currentBucketIndex: number;
  readonly totalEstimatedHeight: number;
  readonly bucketSize: number;
  readonly cssStyle: HybridBucketCssStyle;
}

function findBucketIndexAtOffset(
  buckets: readonly { offsetTop: number; estimatedHeight: number }[],
  targetOffset: number
): number {
  if (buckets.length === 0 || targetOffset <= 0) return 0;
  let lo = 0;
  let hi = buckets.length - 1;
  let matched = hi;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const bucket = buckets[mid];
    if (bucket && bucket.offsetTop + bucket.estimatedHeight <= targetOffset) {
      lo = mid + 1;
    } else {
      matched = mid;
      hi = mid - 1;
    }
  }
  return matched;
}

/**
 * 100 行分桶混合虚拟化计算器 (`computeHybridBuckets`)。
 * 将长对话按固定桶容量划分为连续 `MessageBucket`，仅激活当前桶及前后相邻桶（最多 3 个活跃 Bucket）。
 */
export function computeHybridBuckets(
  input: ComputeHybridBucketsOptions | readonly HybridBucketInputItem[],
  scrollTopArg = 0,
  viewportHeightArg = 600,
  extraOpt?: number | Partial<ComputeHybridBucketsOptions>
): HybridBucketComputationResult {
  const extra =
    typeof extraOpt === 'number' ? { bucketSize: extraOpt } : (extraOpt ?? {});
  const opts: ComputeHybridBucketsOptions = Array.isArray(input)
    ? {
        messages: input,
        scrollTop: scrollTopArg,
        viewportHeight: viewportHeightArg,
        ...extra,
      }
    : (input as ComputeHybridBucketsOptions);

  const rawItems = opts.messages ?? opts.messageIds ?? [];
  const totalItems = rawItems.length;
  const rawBucketSize = normalizeNonNegInt(
    opts.bucketSize ?? DEFAULT_HYBRID_BUCKET_SIZE
  );
  const bucketSize = Math.max(1, rawBucketSize || DEFAULT_HYBRID_BUCKET_SIZE);
  const defaultH = normalizePositiveFloat(opts.defaultItemHeight ?? 72, 72);
  const safeScrollTop = normalizeNonNegFloat(opts.scrollTop ?? 0);
  const safeViewportH = normalizePositiveFloat(opts.viewportHeight ?? 600, 600);
  const cssStyle = createHybridBucketCssStyle(defaultH);

  const totalBuckets = Math.ceil(totalItems / bucketSize);
  const buckets: MessageBucket[] = new Array(totalBuckets);
  const activeBuckets: MessageBucket[] = [];
  const activeBucketIndices: number[] = [];
  let totalEstimatedHeight = 0;

  for (let bIdx = 0; bIdx < totalBuckets; bIdx++) {
    const startIndex = bIdx * bucketSize;
    const endIndex = Math.min(totalItems, startIndex + bucketSize);
    const messageIds: string[] = new Array(endIndex - startIndex);
    let estimatedHeight = 0;

    for (let i = startIndex; i < endIndex; i++) {
      const item = rawItems[i];
      if (item === undefined) continue;
      const id = typeof item === 'string' ? item : item.id;
      messageIds[i - startIndex] = id;
      const rawH = opts.getItemHeight
        ? opts.getItemHeight(id, i)
        : ((typeof item === 'object' ? item.estimatedHeight : undefined) ??
          defaultH);
      estimatedHeight += normalizePositiveFloat(rawH, defaultH);
    }

    buckets[bIdx] = {
      bucketIndex: bIdx,
      startIndex,
      endIndex,
      messageIds,
      estimatedHeight,
      offsetTop: totalEstimatedHeight,
      isActive: false,
      isCollapsedPlaceholder: true,
      cssStyle,
    };
    totalEstimatedHeight += estimatedHeight;
  }

  let currentBucketIndex = -1;
  if (totalBuckets > 0) {
    const clampedTop = Math.min(
      safeScrollTop,
      Math.max(0, totalEstimatedHeight - safeViewportH)
    );
    const anchorOffset = Math.min(
      totalEstimatedHeight,
      clampedTop + safeViewportH * 0.5
    );
    currentBucketIndex = findBucketIndexAtOffset(buckets, anchorOffset);
    const minActive = Math.max(0, currentBucketIndex - 1);
    const maxActive = Math.min(totalBuckets - 1, currentBucketIndex + 1);

    for (let bIdx = minActive; bIdx <= maxActive; bIdx++) {
      const b = buckets[bIdx];
      if (!b) continue;
      const activeBucket: MessageBucket = {
        ...b,
        isActive: true,
        isCollapsedPlaceholder: false,
      };
      buckets[bIdx] = activeBucket;
      activeBuckets.push(activeBucket);
      activeBucketIndices.push(bIdx);
    }
  }

  return Object.assign(buckets, {
    buckets,
    activeBuckets,
    activeBucketIndices,
    currentBucketIndex,
    totalEstimatedHeight,
    bucketSize,
    cssStyle,
  });
}
