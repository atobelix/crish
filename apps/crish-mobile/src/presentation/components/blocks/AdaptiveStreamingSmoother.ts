// 自适应流式打字平准器（Adaptive Streaming Smoother）
// 严格对齐《04 · 移动端 AI 流式匀速输出与智能跟随滚动方案》§3
// 解决远端网络抖动、SSE 数据包批量合并与本地小模型首字预填充造成的忽快忽慢与突发爆字痛点。
// 核心机制：
// 1. Token 缓冲池（Backlog Buffer）：解耦网络吐字脉冲与人眼渲染频率；
// 2. 自适应目标速度（Target Velocity）：人体工效学黄金阅读速度 25~45 字符/秒，积压增加平滑调高（上限 70 字符/秒），积压减少平缓降速抗断流；
// 3. 惯性低通加减速滤波器（Inertial Easing Filter）：C^1 连续加减速过渡（150~300ms 周期），绝无阶跃式忽快忽慢；
// 4. Unicode 字符簇安全边界（Grapheme Cluster Snapping）：避免 Emoji（如 👩‍💻 / 😀）及多字节字符截断为乱码；
// 5. 流结束快速收敛（Graceful Drain / Flush）：网络流关闭时平滑泄洪，并在 deadline 到期或即时打断时 100% 完整交付无字符遗漏；
// 6. 出生登记（波 6 达标步，2026-11-05）：本平准器是流式呈现的唯一时钟——浮点
//    游标每越过一个字素末端，即按游标轨迹在该步时间窗内插值登记其 birthTime
//    （等价参考实现 ai.html 的亚帧插值），供 temporalFade 模型换算时间渐显；
//    文本揭示完毕但渐显未走完时，滴答继续以提交节流产出渐显帧，直至全部
//    字素固化才停钟——呈现层不另设第二套节拍。

import {
  FADE_DURATION_MS,
  FADE_WINDOW_GRAPHEMES,
  splitGraphemes,
} from '@/domain/pure/markdown/temporalFade';

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

/** 出生登记分段扩展块长（code units）：游标临近已分段末端时按块续分段 */
const SEGMENT_CHUNK_UNITS = 2048;
/** 分段表剪枝触发长度：超过后丢弃最旧的已揭示字素边界（保留最近 128 个） */
const SEGMENT_PRUNE_THRESHOLD = 512;
const SEGMENT_KEEP_REVEALED = 128;
/** 渐显活跃扫描窗口（自最新已揭示字素向前数） */
const BIRTH_SCAN_LIMIT = FADE_WINDOW_GRAPHEMES + 24;
/** 每帧快照携带的尾部出生登记条数（渐显窗口 40 + 段/源字素计数偏差余量） */
const TAIL_BIRTHS_FRAME_LIMIT = 64;

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

  // ===== 出生登记（birthTime）状态 =====
  /** 已分段字素的 code-unit 结束偏移（升序，可被剪枝为窗口式） */
  private segEnds: number[] = [];
  /** 与 segEnds 平行：该字素的出生时刻；null = 未登记（按已固化处理） */
  private segBirths: (number | null)[] = [];
  /** 已分段到的 code-unit 偏移（恒为字素边界或文本末端） */
  private segmentedUpTo = 0;
  /** segEnds 中已被游标越过（出生已处理）的条数 */
  private revealedSegCount = 0;
  /** 最近一次提交的文本（快照读取用） */
  private lastCommittedText = '';

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
    // 目标被改写（非纯追加）时，分歧点之后的出生登记随旧文本一并失效
    if (this.targetText !== '' && text !== this.targetText) {
      const limit = Math.min(text.length, this.targetText.length);
      let common = 0;
      while (
        common < limit &&
        text.charCodeAt(common) === this.targetText.charCodeAt(common)
      ) {
        common++;
      }
      if (common < this.segmentedUpTo) {
        this.invalidateAfter(common);
      }
    }
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
        // 首发字素无轨迹可插值，出生时刻即当前时刻
        this.recordBirths(0, safeInitial, this.lastCommitTime, this.lastCommitTime);
        this.emitCommit(this.targetText.slice(0, safeInitial), false);
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
    this.emitCommit(this.targetText, true);
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
    this.resetSegmentation();
    this.lastCommittedText = '';
  }

  /**
   * 种子化：把当前全文视为已揭示完毕（挂载 / 条目切换时调用，避免对已在
   * 屏上的长文本重新逐字打字）。流式期给末尾渐显窗口内的字素按年龄梯度
   * 合成出生时刻（最旧者近固化、最新者刚出生），挂载后由渐显帧自然走完；
   * 窗口外字素无出生登记 = 已固化。非流式期不登记出生（终态纯文本）。
   */
  seed(text: string, streaming: boolean): void {
    this.stopTicking();
    this.targetText = text;
    this.isStreaming = streaming;
    this.isDraining = false;
    this.displayedLength = text.length;
    this.virtualProgress = text.length;
    // 流式期种子化后随即有增量到达：初速预置基准速度（与首发分支同口径），
    // 避免游标自 0 冷启动加速造成的挂载后顿感
    this.currentVelocity = streaming ? this.baseV : 0;
    this.lastTickTime = 0;
    this.lastCommitTime = this.now();
    this.resetSegmentation();

    // 仅分段末尾窗口（种子化不需要全量字素边界，保持 O(窗口）)
    const windowGraphemes = FADE_WINDOW_GRAPHEMES + 24;
    const candidateLength = Math.min(text.length, windowGraphemes * 6);
    let candidateOffset = text.length - candidateLength;
    if (candidateOffset > 0) {
      const prevCode = text.charCodeAt(candidateOffset - 1);
      if (prevCode >= 0xd800 && prevCode <= 0xdbff) {
        candidateOffset -= 1;
      }
    }
    const parts = splitGraphemes(text.slice(candidateOffset));
    const keep = parts.slice(Math.max(0, parts.length - windowGraphemes));
    let offset = text.length - keep.join('').length;
    for (const g of keep) {
      offset += g.length;
      this.segEnds.push(offset);
      this.segBirths.push(null);
    }
    this.segmentedUpTo = text.length;
    this.revealedSegCount = this.segEnds.length;

    if (streaming) {
      const k = Math.min(this.segEnds.length, FADE_WINDOW_GRAPHEMES);
      const now = this.now();
      for (let j = 0; j < k; j++) {
        const idx = this.segEnds.length - k + j;
        // 年龄梯度：最旧者 (FADE_DURATION_MS × k/(k+1))、最新者 (× 1/(k+1))
        this.segBirths[idx] = now - (FADE_DURATION_MS * (k - j)) / (k + 1);
      }
    }
    this.lastCommittedText = text;
    if (streaming && this.hasActiveFade(this.now())) {
      this.ensureTicking();
    }
  }

  /**
   * 尾部出生登记：已揭示文本末尾至多 limit 个字素的出生时刻（旧→新），
   * null = 无登记（已固化）。供呈现帧与 temporalFade 模型配对消费。
   */
  getTailBirths(limit: number): (number | null)[] {
    let shown = Math.min(this.revealedSegCount, this.segEnds.length);
    while (shown > 0 && this.segEnds[shown - 1]! > this.displayedLength) {
      shown--;
    }
    while (
      shown < this.segEnds.length &&
      this.segEnds[shown]! <= this.displayedLength
    ) {
      shown++;
    }
    const from = Math.max(0, shown - limit);
    return this.segBirths.slice(from, shown);
  }

  /** 当前呈现快照（文本 + 尾部出生登记 + 平准器时钟读数） */
  getSnapshot(): {
    text: string;
    tailBirths: (number | null)[];
    atTime: number;
  } {
    return {
      text: this.lastCommittedText,
      tailBirths: this.getTailBirths(TAIL_BIRTHS_FRAME_LIMIT),
      atTime: this.now(),
    };
  }

  /**
   * 单步物理推进（支持外部单测手动推进或 rAF 自动调度）
   * @param currentTime 可选传入指定时间戳（ms）
   */
  step(currentTime?: number): void {
    const nowTime = currentTime ?? this.now();
    const prevTime = this.lastTickTime === 0 ? nowTime : this.lastTickTime;
    const prevProgress = this.virtualProgress;
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

    // 积压已耗尽：若流结束则全量 flush 收工；若仍在流式中——渐显未走完时
    // 继续以提交节流产出渐显帧（文本不变、透明度随同一时钟推进），全部
    // 字素固化后才暂停滴答等待下一网络包
    if (backlog <= 0 && this.displayedLength >= targetLen) {
      if (!this.isStreaming) {
        this.flushImmediately();
      } else if (this.hasActiveFade(nowTime)) {
        if (nowTime - this.lastCommitTime >= this.throttleMs) {
          this.lastCommitTime = nowTime;
          this.emitCommit(
            this.targetText.slice(0, this.displayedLength),
            false
          );
        }
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
    // 游标每越过一个字素末端，按轨迹在 [prevTime, nowTime] 内插值登记出生
    this.recordBirths(prevProgress, this.virtualProgress, prevTime, nowTime);
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
        this.emitCommit(
          this.targetText.slice(0, this.displayedLength),
          false
        );
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
      if (this.shouldKeepTicking()) {
        this.rafId = this.raf(tick);
      }
    };
    this.rafId = this.raf(tick);
  }

  /** 滴答存续条件：泄洪中 / 尚有未揭示文本 / 流式中且渐显未走完 */
  private shouldKeepTicking(): boolean {
    if (this.isDraining) return true;
    if (this.displayedLength < this.targetText.length) return true;
    return this.isStreaming && this.hasActiveFade(this.now());
  }

  /** 统一提交出口：登记最近提交文本后回调 */
  private emitCommit(text: string, isCompleted: boolean): void {
    this.lastCommittedText = text;
    this.onCommit(text, isCompleted);
  }

  /** 是否仍有字素处于渐显时长内（出生登记扫描，仅查尾部窗口） */
  private hasActiveFade(nowMs: number): boolean {
    const start = Math.max(0, this.revealedSegCount - BIRTH_SCAN_LIMIT);
    const end = Math.min(this.revealedSegCount, this.segBirths.length);
    for (let i = start; i < end; i++) {
      const b = this.segBirths[i];
      if (b !== null && b !== undefined && nowMs - b < FADE_DURATION_MS) {
        return true;
      }
    }
    return false;
  }

  /** 清空出生登记分段状态 */
  private resetSegmentation(): void {
    this.segEnds = [];
    this.segBirths = [];
    this.segmentedUpTo = 0;
    this.revealedSegCount = 0;
  }

  /**
   * 按块续分段：把 segmentedUpTo 之后的目标文本切成字素并登记结束偏移。
   * 非末块丢弃最后一字素（可能与后续文本连成复合字素），留待下块重切。
   */
  private extendSegmentation(): void {
    const text = this.targetText;
    while (this.segmentedUpTo < text.length) {
      const chunkEnd = Math.min(
        text.length,
        this.segmentedUpTo + SEGMENT_CHUNK_UNITS
      );
      const parts = splitGraphemes(text.slice(this.segmentedUpTo, chunkEnd));
      if (parts.length === 0) break;
      let usable = chunkEnd < text.length ? parts.length - 1 : parts.length;
      if (usable <= 0) usable = 1; // 单字素长于整块的极端情形：强制收一个保证推进
      let offset = this.segmentedUpTo;
      for (let i = 0; i < usable; i++) {
        offset += parts[i]!.length;
        this.segEnds.push(offset);
        this.segBirths.push(null);
      }
      this.segmentedUpTo = offset;
    }
  }

  /**
   * 登记出生：游标在 [fromTime, toTime] 内自 fromProgress 推进到 toProgress，
   * 途中越过的每个字素末端按轨迹线性插值得到出生时刻（亚帧插值）。
   * 无位移（span ≤ 0）时只推进处理指针，被越过的字素保持无登记 = 已固化
   * （瞬时冲刷/种子化等跳变不产生渐显）。
   */
  private recordBirths(
    fromProgress: number,
    toProgress: number,
    fromTime: number,
    toTime: number
  ): void {
    if (toProgress <= 0) return;
    this.extendSegmentation();
    const span = toProgress - fromProgress;
    while (this.revealedSegCount < this.segEnds.length) {
      const end = this.segEnds[this.revealedSegCount]!;
      if (end > toProgress) break;
      if (
        end > fromProgress &&
        span > 0 &&
        this.segBirths[this.revealedSegCount] === null
      ) {
        this.segBirths[this.revealedSegCount] =
          fromTime + ((end - fromProgress) / span) * (toTime - fromTime);
      }
      this.revealedSegCount++;
    }
    this.pruneSegments();
  }

  /** 目标改写时失效分歧点（pos）之后的分段与出生登记 */
  private invalidateAfter(pos: number): void {
    while (
      this.segEnds.length > 0 &&
      this.segEnds[this.segEnds.length - 1]! > pos
    ) {
      this.segEnds.pop();
      this.segBirths.pop();
    }
    this.segmentedUpTo =
      this.segEnds.length > 0
        ? this.segEnds[this.segEnds.length - 1]!
        : pos;
    if (this.revealedSegCount > this.segEnds.length) {
      this.revealedSegCount = this.segEnds.length;
    }
  }

  /** 分段表剪枝：仅保留最近的已揭示字素 + 全部未揭示字素 */
  private pruneSegments(): void {
    if (this.segEnds.length <= SEGMENT_PRUNE_THRESHOLD) return;
    const excess = this.revealedSegCount - SEGMENT_KEEP_REVEALED;
    if (excess <= 0) return;
    this.segEnds.splice(0, excess);
    this.segBirths.splice(0, excess);
    this.revealedSegCount -= excess;
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
