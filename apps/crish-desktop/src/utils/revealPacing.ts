/**
 * 流式显现节律的速度域（R11 / AN4 共建，单一出生地）。
 *
 * 显示侧定速排空的全部节律常数只在本文件定义：R11 的 RevealPacer
 * （正文 / 思考文本显现）与 AN4 的工具内容伪流式（文本输出行式排空）
 * 共用同一速度域——稳态 2600 字/s、追赶 5200 字/s、单帧硬顶 420 字、
 * 啮合门槛 240 字。改值须 R11 / AN4 两案共同裁决，消费方不得另写
 * 字面量。本模块只含纯数值逻辑与切点选择（切点的 grapheme 安全由
 * 调用方注入的函数保证），不依赖 React、不依赖数据侧 store。
 */

export interface RevealPacingProfile {
  /** 啮合门槛（字）：到达文本不超过此长度时显现恒等到达（短回复零附加延迟） */
  engageThresholdChars: number;
  /** 目标滞后的时间常数（秒）：目标滞后 = 到达速率 EWMA × 此值 */
  targetLagSeconds: number;
  /** 目标滞低下限（字） */
  targetLagMinChars: number;
  /** 目标滞后上限（字） */
  targetLagMaxChars: number;
  /** 比例控制增益（秒）：速率修正 =（实际滞后 − 目标滞后）/ 此值 */
  gainSeconds: number;
  /** 稳态显现速率封顶（字/s） */
  steadyCapCharsPerSec: number;
  /** 追赶显现速率封顶（字/s，大滞后时启用） */
  catchUpCapCharsPerSec: number;
  /** 启用追赶封顶的滞后门槛（字） */
  catchUpLagThresholdChars: number;
  /** 单帧硬顶（字）：任何单帧的显现增量不得越过（单个字形簇不可分除外） */
  frameHardCapChars: number;
  /**
   * 防饥饿速率下限（字/s）：只要有待显现文本，显现速率不低于此值。
   * 经帧预算累加器折算，最坏约每 33ms 吐一个字——显现永不冻结，
   * 到达停顿时的防抖预留也以此速慢慢泄掉，不会永久扣住文本。
   */
  minRateCharsPerSec: number;
  /** 收尾 snap 门槛（字）：流结束时余量不超过此值即刻全显 */
  finishSnapChars: number;
  /** 收尾泄空时长（秒）：大余量按 余量 / 此值 的速率匀速泄空（受追赶封顶约束） */
  finishDrainSeconds: number;
  /** 到达速率 EWMA 的时间常数（秒） */
  ewmaTauSeconds: number;
}

type SharedPacingConstants = Omit<
  RevealPacingProfile,
  'targetLagSeconds' | 'steadyCapCharsPerSec' | 'catchUpCapCharsPerSec'
>;

const SHARED_PACING: SharedPacingConstants = {
  engageThresholdChars: 240,
  targetLagMinChars: 80,
  targetLagMaxChars: 700,
  gainSeconds: 0.9,
  catchUpLagThresholdChars: 2_600,
  frameHardCapChars: 420,
  minRateCharsPerSec: 30,
  finishSnapChars: 300,
  finishDrainSeconds: 0.7,
  ewmaTauSeconds: 0.4,
};

/** 正文显现参数（R11 定案起始值，由回放夹具指标裁决微调） */
export const TEXT_REVEAL_PACING: RevealPacingProfile = {
  ...SHARED_PACING,
  targetLagSeconds: 0.35,
  steadyCapCharsPerSec: 2_600,
  catchUpCapCharsPerSec: 5_200,
};

/**
 * 思考显现参数：与正文同策略、异参数（思考到达更突发——目标滞后
 * 时间常数放宽到 0.5s、双封顶抬高到 3600 / 6800）。
 */
export const THINKING_REVEAL_PACING: RevealPacingProfile = {
  ...SHARED_PACING,
  targetLagSeconds: 0.5,
  steadyCapCharsPerSec: 3_600,
  catchUpCapCharsPerSec: 6_800,
};

export type RevealPacingProfileName = 'text' | 'thinking';

export function revealPacingProfile(
  name: RevealPacingProfileName
): RevealPacingProfile {
  return name === 'thinking' ? THINKING_REVEAL_PACING : TEXT_REVEAL_PACING;
}

/** 目标滞后（字）= clamp（到达速率 EWMA × 目标滞后时间常数，下限，上限） */
export function targetLagChars(
  profile: RevealPacingProfile,
  ewmaCharsPerSec: number
): number {
  const raw = ewmaCharsPerSec * profile.targetLagSeconds;
  return Math.min(
    profile.targetLagMaxChars,
    Math.max(profile.targetLagMinChars, raw)
  );
}

/**
 * 当前应采用的显现速率（字/s）：EWMA 基准 + 滞后比例修正，
 * 再由稳态 / 追赶封顶与防饥饿下限裁决。lag ≤ 0 时恒为 0。
 */
export function revealRateCharsPerSec(
  profile: RevealPacingProfile,
  ewmaCharsPerSec: number,
  lagChars: number
): number {
  if (lagChars <= 0) return 0;
  const target = targetLagChars(profile, ewmaCharsPerSec);
  const corrected = ewmaCharsPerSec + (lagChars - target) / profile.gainSeconds;
  const cap =
    lagChars > profile.catchUpLagThresholdChars
      ? profile.catchUpCapCharsPerSec
      : profile.steadyCapCharsPerSec;
  return Math.min(cap, Math.max(profile.minRateCharsPerSec, corrected));
}

/**
 * 在 [from, from + maxAdvance] 内挑本帧显现切点（返回绝对下标）。
 *
 * 偏好序：切片后段的行尾（'\n' 之后）→ 空白之后 → grapheme 安全点。
 * 只在候选区间的后 40% 里找自然边界，避免为找边界过度让速；结构块
 * 因此尽量在自然边界处被显现流切分（与呈现完成门的接缝约定）。
 * graphemeSafeCut(text, end) 须返回 ≤ end 的最大字形簇边界（绝对下标）。
 * 本函数不保证正向推进：首个字形簇长于 maxAdvance 时返回 from，
 * 推进保证由调用方强制落到下一个字形簇边界（字形簇不可分）。
 */
export function pickRevealCutEnd(
  text: string,
  from: number,
  maxAdvance: number,
  graphemeSafeCut: (text: string, end: number) => number
): number {
  const hardEnd = Math.min(text.length, from + maxAdvance);
  if (hardEnd >= text.length) return text.length;
  if (hardEnd <= from) return from;
  const windowStart = from + Math.floor(maxAdvance * 0.6);
  for (let i = hardEnd; i > windowStart; i--) {
    if (text[i - 1] === '\n') return i;
  }
  for (let i = hardEnd; i > windowStart; i--) {
    const ch = text[i - 1];
    if (ch === ' ' || ch === '\t') return i;
  }
  return graphemeSafeCut(text, hardEnd);
}
