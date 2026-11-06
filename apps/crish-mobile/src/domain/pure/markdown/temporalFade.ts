// apps/crish-mobile/src/domain/pure/markdown/temporalFade.ts
// AI 流式文本末端时间渐显模型（波 6 达标步，2026-11-05 用户题 10 裁决）
// 口径（对齐用户给的参考实现 D:\download\ai.html，并按 Android 平台特性落地）：
// 1. 动效语言只有透明度：无阴影、无模糊、无位移（守卫 noShadow.guard 钉死）；
// 2. 渐显是时间维度的：每个字素簇在被平准游标揭示时记 birthTime，透明度按
//    幂曲线在 FADE_DURATION_MS 内从 FADE_START_ALPHA 升至 1，升满即并回稳定
//    前缀纯文本——不存在「末尾恒半透明」的空间静态梯度（旧模型已删除）；
// 3. 透明度经 color 的 alpha 通道实现（withAlpha），不用 Text 节点 opacity：
//    Android 上字形以目标色单次光栅化、边缘灰阶按最终对比度自然计算，与
//    定稿的衔接是纯粹的同色阶变深；节点 opacity 走离屏合成、边缘失真，
//    已被方案否决；
// 4. 出生时刻由 AdaptiveStreamingSmoother 的浮点游标推进决定（含亚帧插值），
//    本模块只做纯函数换算：birthTime 列表（按文本末尾锚定）+ 当前时刻 →
//    稳定前缀 + 渐显分段；保持字符守恒与 O(1) 量级（仅窗口内分段）。

/** 渐显时长（ms）：与参考实现同量级（560ms）——动效求与结果同步的顺滑，不求快 */
export const FADE_DURATION_MS = 560;
/** 渐显起始透明度：不从 0 起步，避免刚写出的字全黑看不清（参考实现 0.22) */
export const FADE_START_ALPHA = 0.22;
/** 幂曲线指数 gamma：起步提亮较快、临近 1 放缓（参考实现 1.20) */
export const FADE_GAMMA = 1.2;
/** 渐显窗口（字素数）：约 1–1.5 行，窗口外一律已固化为稳定前缀 */
export const FADE_WINDOW_GRAPHEMES = 40;
/** 分段合并的透明度量化步长：相邻字素量化后同值合并为一段，控制节点数 */
export const FADE_ALPHA_QUANTUM = 0.04;

/**
 * 尾部出生登记帧：由平准器随每次提交产出，StreamingText → MarkdownText →
 * StreamingTailText 沿末块路径透传。
 * births 为「已揭示文本末尾若干字素」的出生时刻（旧→新排列，与文本末尾
 * 对齐配对），null 表示该字素无出生登记（早于登记窗口 / 已固化），按
 * 完全显形处理；atTime 为产出本帧的平准器时钟读数（与 birthTime 同时钟）。
 */
export interface TailFadeFrame {
  births: readonly (number | null)[];
  atTime: number;
}

export interface FadeSegment {
  /** 分段文本 */
  text: string;
  /** 该段渲染透明度 (0, 1]（经 color alpha 通道施加，非节点 opacity) */
  alpha: number;
}

export interface TemporalFadePartition {
  /** 已完全显形的稳定前缀（以正文原色纯文本渲染） */
  solidPrefix: string;
  /** 仍在渐显中的尾部分段（透明度自旧向新递减） */
  segments: FadeSegment[];
}

export interface TemporalFadeConfig {
  /** 渐显窗口字素数（缺省 FADE_WINDOW_GRAPHEMES) */
  windowGraphemes?: number;
}

/**
 * Unicode 字素安全切分（与 tailGradient 旧址同实现，迁入本模块继续服役）
 */
export function splitGraphemes(str: string): string[] {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, {
      granularity: 'grapheme',
    });
    return Array.from(segmenter.segment(str), (s) => s.segment);
  }
  return Array.from(str);
}

/**
 * 单个字素在 nowMs 时刻的渐显透明度：
 * progress = (now - birth) / FADE_DURATION_MS，钳制 [0, 1]；
 * alpha = FADE_START_ALPHA + (1 - FADE_START_ALPHA) × progress^FADE_GAMMA；
 * progress ≥ 1 时恰为 1（并回稳定前缀）；birthTime 非有限值视为已固化 = 1。
 */
export function fadeAlphaAt(birthTimeMs: number, nowMs: number): number {
  if (!Number.isFinite(birthTimeMs)) return 1;
  const progress = (nowMs - birthTimeMs) / FADE_DURATION_MS;
  if (progress <= 0) return FADE_START_ALPHA;
  if (progress >= 1) return 1;
  return FADE_START_ALPHA + (1 - FADE_START_ALPHA) * Math.pow(progress, FADE_GAMMA);
}

/**
 * 把文本切分为稳定前缀 + 渐显分段：
 * - 仅末尾 windowGraphemes 个字素参与判定（候选窗口截取，O(1) 量级）；
 * - 字素与 tailBirths 自末尾对齐配对：距末尾第 d 个字素取
 *   tailBirths[tailBirths.length - 1 - d]；无登记（null / 超出列表）= 已固化；
 * - 自窗口起点起第一个未升满的字素起进入分段区，其前全部并入稳定前缀；
 * - 分段按量化透明度合并相邻字素（同值一段），段数恒小；
 * - 字符守恒：solidPrefix + 各段 text 拼接恒等于入参 text。
 */
export function partitionTemporalFade(
  text: string,
  tailBirths: readonly (number | null)[],
  nowMs: number,
  config: TemporalFadeConfig = {}
): TemporalFadePartition {
  if (!text) {
    return { solidPrefix: '', segments: [] };
  }
  const windowGraphemes = config.windowGraphemes ?? FADE_WINDOW_GRAPHEMES;

  // 候选窗口：仅截取末尾一小段做字素切分，长文本保持 O(1)
  // （一个字素最多约 12 个 UTF-16 code units，如复合 Emoji 序列）
  const candidateLength = Math.min(text.length, windowGraphemes * 6);
  let candidateOffset = text.length - candidateLength;
  // 避免 candidateOffset 落在 UTF-16 代理对中间
  if (candidateOffset > 0) {
    const prevCode = text.charCodeAt(candidateOffset - 1);
    if (prevCode >= 0xd800 && prevCode <= 0xdbff) {
      candidateOffset -= 1;
    }
  }
  const candidateGraphemes = splitGraphemes(text.slice(candidateOffset));
  const tailCount = Math.min(candidateGraphemes.length, windowGraphemes);
  const tailGraphemes = candidateGraphemes.slice(
    candidateGraphemes.length - tailCount
  );
  const headText = text.slice(0, text.length - tailGraphemes.join('').length);

  // 逐字素求透明度（与 tailBirths 自末尾配对）
  const alphas: number[] = new Array<number>(tailCount);
  let fadeStart = -1;
  for (let j = 0; j < tailCount; j++) {
    const fromEnd = tailCount - 1 - j;
    const birth =
      fromEnd < tailBirths.length
        ? tailBirths[tailBirths.length - 1 - fromEnd]
        : null;
    const alpha = birth == null ? 1 : fadeAlphaAt(birth, nowMs);
    alphas[j] = alpha;
    if (fadeStart < 0 && alpha < 1) {
      fadeStart = j;
    }
  }

  if (fadeStart < 0) {
    return { solidPrefix: text, segments: [] };
  }

  const solidPrefix = headText + tailGraphemes.slice(0, fadeStart).join('');
  const segments: FadeSegment[] = [];
  let runText = '';
  let runAlpha = -1;
  for (let j = fadeStart; j < tailCount; j++) {
    const quantized = Math.min(
      1,
      Math.max(
        FADE_START_ALPHA,
        Math.round(alphas[j]! / FADE_ALPHA_QUANTUM) * FADE_ALPHA_QUANTUM
      )
    );
    if (runText && quantized === runAlpha) {
      runText += tailGraphemes[j]!;
    } else {
      if (runText) {
        segments.push({ text: runText, alpha: runAlpha });
      }
      runText = tailGraphemes[j]!;
      runAlpha = quantized;
    }
  }
  if (runText) {
    segments.push({ text: runText, alpha: runAlpha });
  }
  return { solidPrefix, segments };
}

/**
 * 把 alpha 乘进颜色的 alpha 通道，返回 rgba() 串（color-alpha 实现路径）：
 * - 支持 #rgb / #rrggbb / #rrggbbaa / rgb() / rgba()；已有 alpha 时相乘；
 * - alpha ≥ 1 时原样返回入参颜色（渐显完成 = 与定稿完全同色，零偏差）；
 * - 无法解析的颜色格式原样返回（调用方据此渲染原色，不臆造颜色）；
 * - 输出 alpha 保留 3 位小数，避免每帧字符串抖动放大。
 */
export function withAlpha(color: string, alpha: number): string {
  if (alpha >= 1) return color;
  const clamped = Math.min(1, Math.max(0, alpha));
  const parsed = parseColor(color);
  if (!parsed) return color;
  const a = Math.round(parsed.a * clamped * 1000) / 1000;
  return `rgba(${parsed.r}, ${parsed.g}, ${parsed.b}, ${a})`;
}

interface RgbaParts {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(color: string): RgbaParts | null {
  const s = color.trim();
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (/^[0-9a-fA-F]{3}$/.test(hex)) {
      return {
        r: parseInt(hex[0]! + hex[0]!, 16),
        g: parseInt(hex[1]! + hex[1]!, 16),
        b: parseInt(hex[2]! + hex[2]!, 16),
        a: 1,
      };
    }
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: 1,
      };
    }
    if (/^[0-9a-fA-F]{8}$/.test(hex)) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: parseInt(hex.slice(6, 8), 16) / 255,
      };
    }
    return null;
  }
  const fn = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(0|1|0?\.\d+)\s*)?\)$/.exec(
    s
  );
  if (fn) {
    return {
      r: Number(fn[1]),
      g: Number(fn[2]),
      b: Number(fn[3]),
      a: fn[4] === undefined ? 1 : Number(fn[4]),
    };
  }
  return null;
}
