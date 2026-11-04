/**
 * RevealPacer：显示侧定速排空控制器（R11 · 流式显现节律）。
 *
 * 持有 arrived（store 真相，一字不改）与 revealed（准许显现的前缀）
 * 两个长度，逐帧按受控速率推进 revealed：到达与显现解耦，突发被
 * 吸收、停顿不冻结、倾泻化作匀速泄空。数据侧（StreamRenderBuffer
 * 等）一律不动——节奏问题不以延迟数据真相来解。
 *
 * 纯逻辑类：时间戳由调用方以毫秒注入，便于回放夹具确定性验收。
 * 节律常数全部取自 utils/revealPacing 的速度域（R11 / AN4 共建），
 * 本文件不另立字面量。切点选择见 pickRevealCutEnd：grapheme 安全、
 * 偏好行尾 / 空白（与呈现完成门的接缝约定：完成门管「何时可呈现」，
 * 本类只管「以多平滑的速度显现」）。
 */
import { safeGraphemeCutPosition } from '../StreamRenderBuffer';
import {
  pickRevealCutEnd,
  revealRateCharsPerSec,
  TEXT_REVEAL_PACING,
  type RevealPacingProfile,
} from '../../utils/revealPacing';

/** 单个到达样本的速率理智上限（字/s）：超过此值的瞬时样本按此值入 EWMA */
const RATE_SAMPLE_SANITY_CAP = 20_000;
/** grapheme 安全切点的回望窗口（字）：切点判定只需其前方有界上下文 */
const GRAPHEME_LOOKBACK = 256;
/** grapheme 安全切点的前探（字）：须看到包含切点的字形簇闭合 */
const GRAPHEME_LOOKAHEAD = 32;

let sharedSegmenter: Intl.Segmenter | null | undefined;

function getSegmenter(): Intl.Segmenter | null {
  if (sharedSegmenter !== undefined) return sharedSegmenter;
  sharedSegmenter =
    typeof Intl !== 'undefined' && 'Segmenter' in Intl
      ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      : null;
  return sharedSegmenter;
}

/** from 之后第一个字形簇的结束下标（字形簇不可分，强制推进时用） */
function firstClusterEnd(text: string, from: number): number {
  if (from >= text.length) return text.length;
  const seg = getSegmenter();
  if (seg) {
    const window = text.slice(from, from + 64);
    for (const part of seg.segment(window)) {
      return from + part.segment.length;
    }
    return text.length;
  }
  // 降级：按码点前进（代理对不拆分）
  const cp = text.charCodeAt(from);
  return cp >= 0xd800 && cp <= 0xdbff ? from + 2 : from + 1;
}

export class RevealPacer {
  readonly profile: RevealPacingProfile;

  private arrivedText = '';
  private revealedLen = 0;
  /** 是否已建立基线：首个到达快照只登记不显现重演（挂载已在场文本零重演） */
  private hasBaseline = false;
  private engaged = false;
  private finishing = false;
  private finishRate = 0;
  /** 到达速率 EWMA（字/s），在 lastArrivalStamp 时刻取值，查询时按龄衰减 */
  private ewma = 0;
  private lastArrivalStamp = 0;
  private lastTickStamp = 0;
  /** 分数帧预算（字）：低速率时增量以分数累积，避免量化饥饿 */
  private budget = 0;
  private reducedMotion = false;

  constructor(profile: RevealPacingProfile = TEXT_REVEAL_PACING) {
    this.profile = profile;
  }

  get arrivedLength(): number {
    return this.arrivedText.length;
  }

  get revealedLength(): number {
    return this.revealedLen;
  }

  get isEngaged(): boolean {
    return this.engaged;
  }

  get isFinishing(): boolean {
    return this.finishing;
  }

  /** 仍有未显现文本且处于啮合 / 收尾态：调用方应继续驱动帧 */
  get needsFrame(): boolean {
    return (
      (this.engaged || this.finishing) &&
      this.revealedLen < this.arrivedText.length
    );
  }

  /** 显现已收敛到到达全文且不在收尾中 */
  get isSettled(): boolean {
    return !this.finishing && this.revealedLen >= this.arrivedText.length;
  }

  /** 减动效旁路：开启即全显，此后到达恒等显现（延迟本身即要消除的动效） */
  setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
    if (value) {
      this.revealedLen = this.arrivedText.length;
      this.engaged = false;
      this.finishing = false;
      this.budget = 0;
    }
  }

  /**
   * 登记最新到达全文。streaming 为该文本是否仍处于流式到达期。
   * 非前缀分叉（重试 / 编辑 / 权威改写）→ snap 复位：已显现直接
   * 对齐新全文，后续增长重新啮合定速（正确性优先）。
   */
  noteArrived(text: string, now: number, streaming: boolean): void {
    if (this.reducedMotion) {
      this.arrivedText = text;
      this.revealedLen = text.length;
      this.hasBaseline = true;
      this.engaged = false;
      this.finishing = false;
      return;
    }
    if (!this.hasBaseline) {
      // 基线：挂载时已在场的文本是历史，不是待显现的流（零重演）
      this.arrivedText = text;
      this.revealedLen = text.length;
      this.hasBaseline = true;
      this.lastArrivalStamp = now;
      this.lastTickStamp = now;
      return;
    }
    if (text === this.arrivedText) return;
    if (!text.startsWith(this.arrivedText)) {
      this.arrivedText = text;
      this.revealedLen = text.length;
      this.ewma = 0;
      this.lastArrivalStamp = now;
      this.engaged = false;
      this.finishing = false;
      this.budget = 0;
      return;
    }
    const delta = text.length - this.arrivedText.length;
    this.arrivedText = text;
    if (delta > 0) this.sampleArrival(delta, now);
    if (streaming && this.finishing) {
      // 流恢复到达：退出收尾，回到定速口径
      this.finishing = false;
    }
    if (
      !this.engaged &&
      streaming &&
      text.length > this.profile.engageThresholdChars
    ) {
      this.engaged = true;
      this.lastTickStamp = now;
    }
    if (!this.engaged && !this.finishing) {
      // 未啮合：显现恒等到达（短回复与流首段零附加延迟）
      this.revealedLen = text.length;
    }
  }

  /**
   * 流结束收尾：余量 ≤ snap 门槛即刻全显；大余量按
   * 余量 / 收尾时长 的速率匀速泄空（受追赶封顶约束）。
   * 权威全文分叉的 snap 在 noteArrived 的分叉分支处理。
   */
  finish(now: number): void {
    if (this.finishing) return;
    const lag = this.arrivedText.length - this.revealedLen;
    if (lag <= 0) return;
    if (lag <= this.profile.finishSnapChars) {
      this.revealedLen = this.arrivedText.length;
      this.budget = 0;
      return;
    }
    this.finishing = true;
    this.finishRate = Math.min(
      lag / this.profile.finishDrainSeconds,
      this.profile.catchUpCapCharsPerSec
    );
    this.lastTickStamp = now;
  }

  /** 推进一帧，返回新的 revealed 长度 */
  tick(now: number): number {
    if (!this.engaged && !this.finishing) {
      this.revealedLen = this.arrivedText.length;
      this.lastTickStamp = now;
      return this.revealedLen;
    }
    const dtMs = now - this.lastTickStamp;
    this.lastTickStamp = now;
    if (dtMs <= 0) return this.revealedLen;
    const lag = this.arrivedText.length - this.revealedLen;
    if (lag <= 0) {
      this.budget = 0;
      this.finishing = false;
      return this.revealedLen;
    }
    const rate = this.finishing
      ? this.finishRate
      : revealRateCharsPerSec(this.profile, this.effectiveEwma(now), lag);
    // 预算封顶 = 单帧硬顶：长帧间隔（切后台 / 长任务）积压的预算
    // 不会在一帧内倾泻，超额速度直接丢弃而不是事后补吐。
    this.budget = Math.min(
      this.budget + rate * (dtMs / 1000),
      this.profile.frameHardCapChars
    );
    const advance = Math.min(
      Math.floor(this.budget),
      this.profile.frameHardCapChars,
      lag
    );
    if (advance <= 0) return this.revealedLen;
    let end = pickRevealCutEnd(
      this.arrivedText,
      this.revealedLen,
      advance,
      this.graphemeSafeCut
    );
    if (end <= this.revealedLen) {
      // 首个字形簇长于本帧增量：字形簇不可分，整簇落帧
      end = firstClusterEnd(this.arrivedText, this.revealedLen);
    }
    // 按实际推进扣预算：为找自然边界让掉的量留在预算里下帧续用
    this.budget = Math.max(0, this.budget - (end - this.revealedLen));
    this.revealedLen = end;
    if (this.finishing && this.revealedLen >= this.arrivedText.length) {
      this.finishing = false;
    }
    return this.revealedLen;
  }

  /** EWMA 按龄衰减后的有效到达速率：到达停顿越久，估计越趋近 0 */
  private effectiveEwma(now: number): number {
    if (this.ewma <= 0) return 0;
    const ageSec = Math.max(0, (now - this.lastArrivalStamp) / 1000);
    return this.ewma * Math.exp(-ageSec / this.profile.ewmaTauSeconds);
  }

  private sampleArrival(delta: number, now: number): void {
    const dtSec = (now - this.lastArrivalStamp) / 1000;
    if (dtSec > 0.001) {
      const instant = Math.min(delta / dtSec, RATE_SAMPLE_SANITY_CAP);
      if (this.ewma <= 0) {
        this.ewma = instant;
      } else {
        const alpha = 1 - Math.exp(-dtSec / this.profile.ewmaTauSeconds);
        this.ewma += alpha * (instant - this.ewma);
      }
    }
    this.lastArrivalStamp = now;
  }

  /**
   * grapheme 安全切点（绝对下标，≤ hardEnd）：对切点前后的有界窗口
   * 做分段——窗口起点或是已显现边界、或距切点 ≥ 回望距离（分段
   * 边界在该距离内必然再同步），故窗口内的末端边界即全文真边界。
   */
  private graphemeSafeCut = (text: string, hardEnd: number): number => {
    const from = this.revealedLen;
    if (hardEnd <= from) return from;
    if (hardEnd >= text.length) return text.length;
    const start = Math.max(from, hardEnd - GRAPHEME_LOOKBACK);
    const windowText = text.slice(start, hardEnd + GRAPHEME_LOOKAHEAD);
    const cutInWindow = safeGraphemeCutPosition(windowText, hardEnd - start);
    return start + cutInWindow;
  };
}
