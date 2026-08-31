/**
 * AdaptiveAnimateTimeline: 融合速率感知的单挂钟动态时间轴调度器
 *
 * 核心设计：
 * 1. 软预算 B=320ms：单渲染帧内动画交错领先挂钟时间的最大上限；
 * 2. 最小步长下限 S_min=4ms：防止高负载下动画塌缩为 0ms 全体闪现；
 * 3. 跨帧削峰 beginPass：彻底切断历史超调债务累积；
 * 4. StrictMode / 并发渲染幂等支持：mark() 与 rewind() 游标保护。
 */

export interface ScheduleSlot {
  /** 批次内首字/首词的 CSS 延迟 (ms) */
  baseDelay: number;
  /** 词间有效交错步长 (ms) */
  step: number;
  /** 推荐动画持续时间 (ms) */
  duration: number;
  /** 是否允许执行动画 (TURBO 模式下为 false) */
  allowAnimation: boolean;
}

export interface AdaptiveTimelineOptions {
  /** 最大动画积压软预算 B (ms)，默认 320 */
  maxBacklogMs?: number;
  /** 最小交错步长下限 S_min (ms)，默认 4 */
  minStaggerStepMs?: number;
  /** 挂钟时间提供函数 */
  now?: () => number;
}

export class AdaptiveAnimateTimeline {
  private readonly maxBacklogMs: number;
  private readonly minStaggerStepMs: number;
  private readonly nowFn: () => number;

  private committedNextStartAt = 0;
  private passNextStartAt = 0;

  constructor(options?: AdaptiveTimelineOptions) {
    this.maxBacklogMs = options?.maxBacklogMs ?? 320;
    this.minStaggerStepMs = options?.minStaggerStepMs ?? 4;
    this.nowFn = options?.now ?? (() => performance.now());
  }

  public now(): number {
    return this.nowFn();
  }

  /**
   * 启动单次渲染 Pass，清理并削峰历史超调债务
   */
  public beginPass(now: number = this.now()): void {
    this.passNextStartAt = Math.min(
      Math.max(this.committedNextStartAt, now),
      now + this.maxBacklogMs
    );
  }

  /**
   * 记录当前工作游标快照（用于 StrictMode 与并发渲染回滚）
   */
  public mark(): number {
    return this.passNextStartAt;
  }

  /**
   * 回滚工作游标到指定快照
   */
  public rewind(mark: number): void {
    this.passNextStartAt = mark;
  }

  /**
   * 核心槽位申请方法：根据词数、推荐步长与软预算动态分配
   */
  public take(
    wordCount: number,
    idealStagger: number,
    duration: number,
    allowWordSpans: boolean,
    now: number = this.now()
  ): ScheduleSlot {
    if (!allowWordSpans || wordCount <= 0 || idealStagger <= 0) {
      return {
        baseDelay: 0,
        step: 0,
        duration: 0,
        allowAnimation: false,
      };
    }

    const minStep = Math.min(idealStagger, this.minStaggerStepMs);
    const startAt = Math.max(this.passNextStartAt, now);
    const budgetEnd = now + this.maxBacklogMs;
    const idealLast = startAt + Math.max(0, wordCount - 1) * idealStagger;

    let step = idealStagger;

    if (idealLast > budgetEnd && wordCount > 1) {
      if (startAt < budgetEnd) {
        // 在剩余预算中平摊步长，但不得低于 minStep
        const remainingSpan = budgetEnd - startAt;
        step = Math.max(minStep, remainingSpan / (wordCount - 1));
      } else {
        // 预算已耗尽，降级为最小交错步长
        step = minStep;
      }
    }

    const baseDelay = Math.max(0, Math.round(startAt - now));
    this.passNextStartAt = startAt + wordCount * step;

    return {
      baseDelay,
      step,
      duration,
      allowAnimation: true,
    };
  }

  /**
   * 提交本帧时间轴状态（在 React useLayoutEffect 中调用）
   */
  public commitPass(): void {
    this.committedNextStartAt = this.passNextStartAt;
  }

  /**
   * 重置时间轴状态
   */
  public reset(): void {
    this.committedNextStartAt = 0;
    this.passNextStartAt = 0;
  }
}
