/**
 * ToolTextDrain：工具纯文本输出的行式排空控制器（AN4）。
 *
 * 与 R11 RevealPacer 的分工：Pacer 管「文本增量到达」的定速显现
 * （到达/显现解耦）；本控制器面对的是「整块到达」的工具结果——
 * 数据已全量在手，这里只做呈现调度：自 tool-end 落定帧起，按
 * 量级推导的总时长（toolRevealState.drainDurationMs）把全文以
 * 前缀方式逐帧揭示，终帧与静态渲染逐字一致。
 *
 * 帧纪律与 Pacer 同口径：帧预算累加器、单帧硬顶（速度域共用值，
 * 长帧间隔积压的预算在一帧内不倾泻）、切点经 pickRevealCutEnd
 * 偏好行尾（行式排空）、grapheme 安全（首簇过长时整簇落帧）。
 * 纯逻辑类：时钟与 rAF 由调用方注入，便于回放夹具确定性验收。
 */
import { pickRevealCutEnd, TEXT_REVEAL_PACING } from '../../utils/revealPacing';
import { safeGraphemeCutPosition } from '../../api/StreamRenderBuffer';

/** grapheme 安全切点的回望窗口（字）：与 RevealPacer 接缝同值 */
const GRAPHEME_LOOKBACK = 256;
/** grapheme 安全切点的前探（字）：与 RevealPacer 接缝同值 */
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

export interface ToolTextDrainDeps {
  now?: () => number;
  raf?: (cb: FrameRequestCallback) => number;
  cancelRaf?: (id: number) => void;
}

export class ToolTextDrain {
  private revealedLen = 0;
  /** 分数帧预算（字）：按实际推进扣账，为找行尾让掉的量留待下帧 */
  private budget = 0;
  private lastStamp = 0;
  private rafId: number | null = null;
  private started = false;
  private finished = false;
  private disposed = false;

  private readonly text: string;
  private readonly durationMs: number;
  private readonly onReveal: (revealedLength: number) => void;
  private readonly onDone: () => void;
  private readonly deps: ToolTextDrainDeps;

  constructor(
    text: string,
    durationMs: number,
    onReveal: (revealedLength: number) => void,
    onDone: () => void,
    deps: ToolTextDrainDeps = {}
  ) {
    this.text = text;
    this.durationMs = durationMs;
    this.onReveal = onReveal;
    this.onDone = onDone;
    this.deps = deps;
  }

  get revealedLength(): number {
    return this.revealedLen;
  }

  get isDone(): boolean {
    return this.finished;
  }

  start(): void {
    if (this.started || this.finished || this.disposed) return;
    this.started = true;
    this.lastStamp = this.now();
    if (this.text.length === 0) {
      this.finish();
      return;
    }
    this.schedule();
  }

  /** 让位/收尾：剩余内容同帧全量就位（数据在手，不许被动画扣住） */
  settle(): void {
    if (this.finished || this.disposed) return;
    this.cancelFrame();
    if (this.revealedLen < this.text.length) {
      this.revealedLen = this.text.length;
      this.onReveal(this.revealedLen);
    }
    this.finish();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelFrame();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : performance.now();
  }

  private schedule(): void {
    const raf =
      this.deps.raf ??
      ((cb: FrameRequestCallback) => requestAnimationFrame(cb));
    this.rafId = raf(this.step);
  }

  private cancelFrame(): void {
    if (this.rafId === null) return;
    const cancel =
      this.deps.cancelRaf ?? ((id: number) => cancelAnimationFrame(id));
    cancel(this.rafId);
    this.rafId = null;
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.onDone();
  }

  private step = (): void => {
    this.rafId = null;
    if (this.finished || this.disposed) return;
    const now = this.now();
    const dtMs = now - this.lastStamp;
    this.lastStamp = now;
    const lag = this.text.length - this.revealedLen;
    if (lag <= 0) {
      this.finish();
      return;
    }
    if (dtMs > 0) {
      const rateCharsPerSec = this.text.length / (this.durationMs / 1000);
      // 预算封顶 = 单帧硬顶：切后台/长任务积压的预算直接丢弃，
      // 不在一帧内倾泻（与 RevealPacer 同口径）
      this.budget = Math.min(
        this.budget + rateCharsPerSec * (dtMs / 1000),
        TEXT_REVEAL_PACING.frameHardCapChars
      );
    }
    const advance = Math.min(
      Math.floor(this.budget),
      TEXT_REVEAL_PACING.frameHardCapChars,
      lag
    );
    if (advance > 0) {
      let end = pickRevealCutEnd(
        this.text,
        this.revealedLen,
        advance,
        this.graphemeSafeCut
      );
      if (end <= this.revealedLen) {
        // 首个字形簇长于本帧增量：字形簇不可分，整簇落帧
        end = firstClusterEnd(this.text, this.revealedLen);
      }
      this.budget = Math.max(0, this.budget - (end - this.revealedLen));
      this.revealedLen = end;
      this.onReveal(this.revealedLen);
    }
    if (this.revealedLen >= this.text.length) {
      this.finish();
      return;
    }
    this.schedule();
  };

  /**
   * grapheme 安全切点（绝对下标，≤ hardEnd）：与 RevealPacer 相同的
   * 窗口分段法——窗口起点或是已显现边界、或距切点 ≥ 回望距离，
   * 窗口内的末端边界即全文真边界。
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
