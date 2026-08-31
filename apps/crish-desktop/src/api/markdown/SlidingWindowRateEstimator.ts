/**
 * SlidingWindowRateEstimator: 滑动窗口 Token 速率自适应估计器 (SW-TRE)
 *
 * 核心算法：
 * 1. 维护 500ms 环形滑动窗口，计算窗口累计速率与瞬时速率；
 * 2. 非对称动态 EMA 平滑：加速 α=0.5，减速 α=0.2；
 * 3. 冷启动守卫：前 3 个样本强制锁定为 NORMAL 档位，避免首字抖动；
 * 4. 输出 CRAWL / NORMAL / FAST / TURBO 四级速率快照。
 */

export type StreamingTier = 'CRAWL' | 'NORMAL' | 'FAST' | 'TURBO';

export interface RateSnapshot {
  /** 瞬时字符速率 (chars/s) */
  instantRate: number;
  /** 平滑字符速率 (chars/s) */
  smoothedRate: number;
  /** 等效 Token 速率 (tokens/s) */
  tokenRate: number;
  /** 当前推荐运行档位 */
  tier: StreamingTier;
  /** 推荐交错步长 (ms) */
  staggerStepMs: number;
  /** 推荐动画时长 (ms) */
  animationDurationMs: number;
  /** 是否允许包裹细粒度 word span */
  allowWordSpans: boolean;
}

interface RateSample {
  timestamp: number;
  charCount: number;
}

export class SlidingWindowRateEstimator {
  private samples: RateSample[] = [];
  private readonly windowDurationMs: number;
  private smoothedRate = 0;
  private lastTimestamp = 0;

  constructor(windowDurationMs = 500) {
    this.windowDurationMs = windowDurationMs;
  }

  /**
   * 压入新到达的字符增量并计算最新速率快照
   */
  public push(charDelta: number, now: number = performance.now()): RateSnapshot {
    // 1. 首次推入样本初始化
    if (this.lastTimestamp === 0) {
      this.lastTimestamp = now;
      this.samples.push({ timestamp: now, charCount: charDelta });
      return {
        instantRate: 0,
        smoothedRate: 0,
        tokenRate: 0,
        tier: 'NORMAL',
        staggerStepMs: 16,
        animationDurationMs: 100,
        allowWordSpans: true,
      };
    }

    const elapsed = Math.max(1, now - this.lastTimestamp);
    this.lastTimestamp = now;

    // 2. 压入新样本
    this.samples.push({ timestamp: now, charCount: charDelta });

    // 3. 清理过期样本 (维持滑动窗口大小)
    const cutoff = now - this.windowDurationMs;
    while (this.samples.length > 0 && this.samples[0]!.timestamp < cutoff) {
      this.samples.shift();
    }

    // 4. 计算窗口内累计总速率
    let totalChars = 0;
    for (const s of this.samples) {
      totalChars += s.charCount;
    }
    const windowStart = this.samples[0]?.timestamp ?? now;
    const windowElapsed = Math.max(1, now - windowStart);
    const windowRate = (totalChars / windowElapsed) * 1000;

    // 5. 计算瞬时速率并执行非对称 EMA
    const instantRate = (charDelta / elapsed) * 1000;
    if (this.smoothedRate === 0) {
      this.smoothedRate = windowRate;
    } else {
      const alpha = instantRate > this.smoothedRate ? 0.5 : 0.2;
      this.smoothedRate = alpha * instantRate + (1 - alpha) * this.smoothedRate;
    }

    // 6. 换算等效 Token 速率 (1 Token ≈ 3.8 chars)
    const tokenRate = Math.max(0, this.smoothedRate / 3.8);

    // 7. 冷启动守卫：样本不足 3 个时固定为 NORMAL 档位
    if (this.samples.length < 3) {
      return {
        instantRate,
        smoothedRate: this.smoothedRate,
        tokenRate,
        tier: 'NORMAL',
        staggerStepMs: 16,
        animationDurationMs: 100,
        allowWordSpans: true,
      };
    }

    // 8. 派发四级档位
    return this.deriveTierSnapshot(instantRate, this.smoothedRate, tokenRate);
  }

  /**
   * 获取当前速率快照 (不压入新样本)
   */
  public getSnapshot(): RateSnapshot {
    const tokenRate = Math.max(0, this.smoothedRate / 3.8);
    if (this.samples.length < 3) {
      return {
        instantRate: 0,
        smoothedRate: this.smoothedRate,
        tokenRate,
        tier: 'NORMAL',
        staggerStepMs: 16,
        animationDurationMs: 100,
        allowWordSpans: true,
      };
    }
    return this.deriveTierSnapshot(0, this.smoothedRate, tokenRate);
  }

  /**
   * 重置速率估计器状态
   */
  public reset(): void {
    this.samples = [];
    this.smoothedRate = 0;
    this.lastTimestamp = 0;
  }

  private deriveTierSnapshot(
    instantRate: number,
    smoothedRate: number,
    tokenRate: number
  ): RateSnapshot {
    let tier: StreamingTier = 'NORMAL';
    let staggerStepMs = 16;
    let animationDurationMs = 100;
    let allowWordSpans = true;

    if (tokenRate < 15) {
      // Tier 1 (CRAWL): 极慢速逐字打字机
      tier = 'CRAWL';
      staggerStepMs = 40;
      animationDurationMs = 120;
      allowWordSpans = true;
    } else if (tokenRate < 100) {
      // Tier 2 (NORMAL): 常态交错波浪淡入
      tier = 'NORMAL';
      staggerStepMs = Math.max(4, Math.round(400 / tokenRate));
      animationDurationMs = 100;
      allowWordSpans = true;
    } else if (tokenRate < 300) {
      // Tier 3 (FAST): 快速短语级淡入
      tier = 'FAST';
      staggerStepMs = Math.max(2, Math.round(150 / tokenRate));
      animationDurationMs = 60;
      allowWordSpans = true;
    } else {
      // Tier 4 (TURBO): 极速宏块直出，彻底禁止 Word Span
      tier = 'TURBO';
      staggerStepMs = 0;
      animationDurationMs = 0;
      allowWordSpans = false;
    }

    return {
      instantRate,
      smoothedRate,
      tokenRate,
      tier,
      staggerStepMs,
      animationDurationMs,
      allowWordSpans,
    };
  }
}
