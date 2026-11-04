// 自适应流式打字平准器（Adaptive Streaming Smoother）
// 严格对齐《04 · 移动端 AI 流式匀速输出与智能跟随滚动方案》§3
// 解决远端网络抖动、SSE 数据包批量合并与本地小模型首字预填充造成的忽快忽慢与突发爆字痛点。
// 核心机制：
// 1. Token 缓冲池（Backlog Buffer）：解耦网络吐字脉冲与人眼渲染频率；
// 2. 自适应目标速度（Target Velocity）：人体工效学黄金阅读速度 25~45 字符/秒，积压增加平滑调高（上限 70 字符/秒），积压减少平缓降速抗断流；
// 3. 惯性低通加减速滤波器（Inertial Easing Filter）：C^1 连续加减速过渡（150~300ms 周期），绝无阶跃式忽快忽慢；
// 4. Unicode 字符簇安全边界（Grapheme Cluster Snapping）：避免 Emoji（如 👩‍💻 / 😀）及多字节字符截断为乱码；
// 5. 流结束快速收敛（Graceful Drain / Flush）：网络流关闭时平滑泄洪，并在 deadline 到期或即时打断时 100% 完整交付无字符遗漏。

export interface SmootherOptions {
  /** 最小怠速输出速度 (字符/秒，默认 18，抗饥饿保底) */
  minCharsPerSec?: number;
  /** 黄金阅读基准速度 (字符/秒，默认 32，舒适阅读中枢) */
  baseCharsPerSec?: number;
  /** 追赶加速速度 (字符/秒，默认 55) */
  fastCharsPerSec?: number;
  /** 最大泄洪速度 (字符/秒，默认 70，平准速度上限) */
  maxCharsPerSec?: number;
  /** 提交 UI 最小间隔毫秒数 (默认 32ms，约 30Hz 视感节流，节约 50% React Re-render) */
  commitThrottleMs?: number;
  /** 物理时钟注入 (单测/离线仿真用；缺省 performance.now / Date.now) */
  now?: () => number;
  /** requestAnimationFrame 注入 (单测用) */
  requestAnimationFrame?: (cb: (time: number) => void) => number;
  /** cancelAnimationFrame 注入 (单测用) */
  cancelAnimationFrame?: (id: number) => void;
}

export type SmootherCommitCallback = (
  displayText: string,
  isCompleted: boolean
) => void;

/** 缺省参数标定 */
export const SMOOTHER_DEFAULTS = {
  MIN_CHARS_PER_SEC: 18,
  BASE_CHARS_PER_SEC: 32,
  FAST_CHARS_PER_SEC: 55,
  MAX_CHARS_PER_SEC: 70,
  COMMIT_THROTTLE_MS: 32,
  ACCEL_TAU: 0.22, // 加速时间常数 220ms
  DECEL_TAU: 0.35, // 减速时间常数 350ms
  MAX_ACCEL: 100, // 最大提速斜率 (chars/s^2)
  MAX_DECEL: 60, // 最大降速刹车斜率 (chars/s^2)
  DRAIN_MIN_MS: 100, // 泄洪最短时长
  DRAIN_MAX_MS: 280, // 泄洪最长时长
} as const;

/**
 * Unicode 字符簇（Grapheme Cluster）安全边界吸附器
 * 针对 Emoji（包含代理对、零宽连字 ZWJ、变体选择符、肤色/国旗修饰符）实施边界对齐，
 * 绝不将复合字符中间切断产生乱码（\uFFFD）。
 */
export class GraphemeBoundarySnapper {
  private static segmenter: Intl.Segmenter | null =
    typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
      ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      : null;

  /**
   * 寻找小于等于 targetIndex 的最近安全字符簇断点
   */
  static findSafeIndex(text: string, targetIndex: number): number {
    if (targetIndex >= text.length) return text.length;
    if (targetIndex <= 0) return 0;

    // 快速 ASCII 判定：英文字符与普通标点均为单字节，无字符簇跨越
    const prevCode = text.charCodeAt(targetIndex - 1);
    const currCode = text.charCodeAt(targetIndex);
    if (prevCode < 0x80 && currCode < 0x80) {
      return targetIndex;
    }

    // 现代环境：通过 Intl.Segmenter 实现高精度字素边界吸附
    if (this.segmenter) {
      const segments = this.segmenter.segment(text);
      let safeBreak = 0;
      for (const segment of segments) {
        const nextBreak = segment.index + segment.segment.length;
        if (nextBreak <= targetIndex) {
          safeBreak = nextBreak;
        } else {
          break;
        }
      }
      return safeBreak;
    }

    // 降级兜底：检查 UTF-16 高位代理（0xD800 ~ 0xDBFF），避免截断在代理对之间
    if (prevCode >= 0xd800 && prevCode <= 0xdbff) {
      return targetIndex - 1;
    }
    return targetIndex;
  }
}

/**
 * 自适应打字平准器（纯 TypeScript 编写，100% 零 React 依赖）
 */
export class AdaptiveStreamingSmoother {
  private targetText = '';
  private displayedLength = 0;
  private virtualProgress = 0; // 浮点推进位置累加器
  private currentVelocity = 0; // 当前瞬时渲染速度 (chars/s)
  private isStreaming = false;
  private isDraining = false;
  private drainDeadline = 0;

  private rafId: number | null = null;
  private lastTickTime = 0;
  private lastCommitTime = 0;

  private readonly minV: number;
  private readonly baseV: number;
  private readonly fastV: number;
  private readonly maxV: number;
  private readonly throttleMs: number;
  private readonly now: () => number;
  private readonly raf: (cb: (time: number) => void) => number;
  private readonly caf: (id: number) => void;
  private readonly onCommit: SmootherCommitCallback;

  constructor(onCommit: SmootherCommitCallback, options: SmootherOptions = {}) {
    this.onCommit = onCommit;
    this.minV = options.minCharsPerSec ?? SMOOTHER_DEFAULTS.MIN_CHARS_PER_SEC;
    this.baseV =
      options.baseCharsPerSec ?? SMOOTHER_DEFAULTS.BASE_CHARS_PER_SEC;
    this.fastV =
      options.fastCharsPerSec ?? SMOOTHER_DEFAULTS.FAST_CHARS_PER_SEC;
    this.maxV = options.maxCharsPerSec ?? SMOOTHER_DEFAULTS.MAX_CHARS_PER_SEC;
    this.throttleMs =
      options.commitThrottleMs ?? SMOOTHER_DEFAULTS.COMMIT_THROTTLE_MS;
    this.now =
      options.now ??
      (() =>
        typeof performance !== 'undefined' &&
        typeof performance.now === 'function'
          ? performance.now()
          : Date.now());

    this.raf =
      options.requestAnimationFrame ??
      ((cb: (time: number) => void) => {
        if (typeof requestAnimationFrame === 'function') {
          return requestAnimationFrame(cb);
        }
        return setTimeout(() => cb(this.now()), 16) as unknown as number;
      });

    this.caf =
      options.cancelAnimationFrame ??
      ((id: number) => {
        if (typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(id);
          return;
        }
        clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
      });
  }

  /**
   * 推入最新全文或更新流状态（支持覆盖式全文 push）
   * @param text 最新全文内容
   * @param streaming 是否仍处于上游流式传输中
   */
  updateTarget(text: string, streaming: boolean): void {
    this.targetText = text;
    this.isStreaming = streaming;

    // 首次激活且有文本：首帧立即发射 1~2 字符，杜绝用户感知白屏僵死
    if (this.displayedLength === 0 && text.length > 0) {
      if (streaming) {
        const initialStep = Math.min(text.length, 2);
        const safeInitial = GraphemeBoundarySnapper.findSafeIndex(
          text,
          initialStep
        );
        this.displayedLength = safeInitial;
        this.virtualProgress = safeInitial;
        this.currentVelocity = this.baseV;
        this.lastCommitTime = this.now();
        this.onCommit(this.targetText.slice(0, safeInitial), false);
      } else {
        this.flushImmediately();
        return;
      }
    }

    if (!streaming) {
      if (this.displayedLength >= this.targetText.length) {
        this.flushImmediately();
        return;
      }
      // 进入终态平滑泄洪收敛
      this.isDraining = true;
      const remainingBacklog = this.targetText.length - this.displayedLength;
      const drainDuration = Math.min(
        SMOOTHER_DEFAULTS.DRAIN_MAX_MS,
        Math.max(SMOOTHER_DEFAULTS.DRAIN_MIN_MS, (remainingBacklog / 80) * 1000)
      );
      this.drainDeadline = this.now() + drainDuration;
    } else {
      this.isDraining = false;
    }

    this.ensureTicking();
  }

  /**
   * 强制立即刷出全部内容并收尾（用户点击停止/发送新消息/组件卸载）
   */
  flushImmediately(): void {
    this.stopTicking();
    this.displayedLength = this.targetText.length;
    this.virtualProgress = this.targetText.length;
    this.currentVelocity = 0;
    this.isDraining = false;
    this.onCommit(this.targetText, true);
  }

  /**
   * 重置平准器状态
   */
  reset(): void {
    this.stopTicking();
    this.targetText = '';
    this.displayedLength = 0;
    this.virtualProgress = 0;
    this.currentVelocity = 0;
    this.isStreaming = false;
    this.isDraining = false;
    this.drainDeadline = 0;
    this.lastTickTime = 0;
    this.lastCommitTime = 0;
  }

  /**
   * 单步物理推进（支持外部单测手动推进或 rAF 自动调度）
   * @param currentTime 可选传入指定时间戳（ms）
   */
  step(currentTime?: number): void {
    const nowTime = currentTime ?? this.now();
    if (this.lastTickTime === 0) {
      this.lastTickTime = nowTime;
    }
    const dt = Math.max(
      0.001,
      Math.min(0.064, (nowTime - this.lastTickTime) / 1000)
    );
    this.lastTickTime = nowTime;

    const targetLen = this.targetText.length;
    const backlog = Math.max(0, targetLen - this.virtualProgress);

    // 积压已耗尽：若流结束则全量 flush 收工；若仍在流式中则暂停滴答等待下一网络包
    if (backlog <= 0 && this.displayedLength >= targetLen) {
      if (!this.isStreaming) {
        this.flushImmediately();
      } else {
        this.stopTicking();
      }
      return;
    }

    // 1. 计算期望目标速度 V_desired(B)
    const desiredV = this.computeDesiredVelocity(backlog, nowTime);

    // 2. 惯性低通加减速滤波 (Inertial Filtering)
    this.updateVelocity(desiredV, dt);

    // 3. 推进浮点累加器
    this.virtualProgress = Math.min(
      targetLen,
      this.virtualProgress + this.currentVelocity * dt
    );
    const candidateLen = Math.floor(this.virtualProgress);

    // 4. 终态判定与提交节流
    const isFinishedDraining =
      this.isDraining &&
      (candidateLen >= targetLen || nowTime >= this.drainDeadline);
    const isEnd =
      (candidateLen >= targetLen && !this.isStreaming) || isFinishedDraining;

    if (isEnd) {
      this.flushImmediately();
      return;
    }

    const timeSinceLastCommit = nowTime - this.lastCommitTime;
    if (
      candidateLen > this.displayedLength &&
      timeSinceLastCommit >= this.throttleMs
    ) {
      // 对齐 Unicode 字符簇边界
      const safeIndex = GraphemeBoundarySnapper.findSafeIndex(
        this.targetText,
        candidateLen
      );
      if (safeIndex > this.displayedLength) {
        this.displayedLength = safeIndex;
        this.lastCommitTime = nowTime;
        this.onCommit(this.targetText.slice(0, this.displayedLength), false);
      }
    }
  }

  /**
   * 启动物理时钟调度循环
   */
  private ensureTicking(): void {
    if (this.rafId !== null) return;
    this.lastTickTime = this.now();
    const tick = () => {
      this.rafId = null;
      this.step();
      if (this.displayedLength < this.targetText.length || this.isDraining) {
        this.rafId = this.raf(tick);
      }
    };
    this.rafId = this.raf(tick);
  }

  /**
   * 停止物理时钟调度循环
   */
  private stopTicking(): void {
    if (this.rafId !== null) {
      this.caf(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * 依据积压量计算期望目标速度
   */
  private computeDesiredVelocity(backlog: number, currentTime: number): number {
    if (this.isDraining) {
      const remainingTime = Math.max(
        0.016,
        (this.drainDeadline - currentTime) / 1000
      );
      return Math.max(this.baseV, backlog / remainingTime);
    }

    if (backlog <= 0) {
      return this.minV;
    }
    if (backlog <= 12) {
      // 区段 1: 怠速抗断帧区 (18 ~ 32 chars/s)
      return this.minV + (this.baseV - this.minV) * (backlog / 12);
    }
    if (backlog <= 60) {
      // 区段 2: 黄金舒适阅读区 (32 ~ 55 chars/s)
      return (
        this.baseV +
        (this.fastV - this.baseV) * Math.pow((backlog - 12) / 48, 0.8)
      );
    }
    if (backlog <= 200) {
      // 区段 3: 平滑追赶区 (55 ~ 70 chars/s)
      return this.fastV + (this.maxV - this.fastV) * ((backlog - 60) / 140);
    }
    // 区段 4: 应急泄洪区（封顶 maxV = 70 chars/s，杜绝狂飙）
    return this.maxV;
  }

  /**
   * 惯性加减速微分积分
   */
  private updateVelocity(desiredV: number, dt: number): void {
    const isAccelerating = desiredV > this.currentVelocity;
    const tau = isAccelerating
      ? SMOOTHER_DEFAULTS.ACCEL_TAU
      : SMOOTHER_DEFAULTS.DECEL_TAU;
    const maxSlope = isAccelerating
      ? SMOOTHER_DEFAULTS.MAX_ACCEL
      : SMOOTHER_DEFAULTS.MAX_DECEL;

    const rawDeltaV = ((desiredV - this.currentVelocity) / tau) * dt;
    const clampedDeltaV = Math.max(
      -maxSlope * dt,
      Math.min(maxSlope * dt, rawDeltaV)
    );
    this.currentVelocity = Math.max(
      this.minV * 0.5,
      this.currentVelocity + clampedDeltaV
    );
  }

  // ===== 诊断与测试查询方法 =====

  getVelocity(): number {
    return this.currentVelocity;
  }

  getDisplayedLength(): number {
    return this.displayedLength;
  }

  getVirtualProgress(): number {
    return this.virtualProgress;
  }

  getBacklog(): number {
    return Math.max(0, this.targetText.length - this.virtualProgress);
  }

  isDrainingState(): boolean {
    return this.isDraining;
  }

  isTicking(): boolean {
    return this.rafId !== null;
  }
}
