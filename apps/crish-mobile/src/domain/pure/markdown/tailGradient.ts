// apps/crish-mobile/src/domain/pure/markdown/tailGradient.ts
// AI 流式文本末端行内字素梯度分段窗口模型（IGSW，对齐方案 25）
// 核心职责：
// 1. 稳定基底区（solidPrefix）保持 100% 不透明纯文本；
// 2. 末端维护 5 阶渐变衰减梯级（Tier 0 ~ Tier 4：alpha 0.88 衰减至 0.16）；
// 3. 严格基于 Unicode 字符簇（Intl.Segmenter grapheme）切分，保证 Emoji、国旗、复合修饰符零截断；
// 4. 计算耗时常数级 O(1)，单字面字符串拼接 100% 字符守恒。

export interface GradientTier {
  /** 该梯级的不透明度 (0.0 ~ 1.0) */
  opacity: number;
  /** 分配到的文本子串 */
  text: string;
  /** 是否开启微扩散光晕阴影 (模拟高斯模糊与景深弥散) */
  hasGlow?: boolean;
  /** 文本阴影半径 (可选) */
  blurRadius?: number;
}

export interface TailGradientResult {
  /** 已经 100% 固化的稳定文本前缀 */
  solidPrefix: string;
  /** 渐变末端梯级数组 (从深到浅排列，Tier 0 -> Tier K-1) */
  tiers: GradientTier[];
}

export interface TailGradientConfig {
  /** 渐变窗口总字素目标长度 (默认 24) */
  windowGraphemes?: number;
  /** 最小起始透明度 (默认 0.16) */
  minOpacity?: number;
  /** 最大过渡透明度 (默认 0.88) */
  maxOpacity?: number;
  /** 是否在末梢梯级注入微发光阴影以模拟高斯模糊 (默认 true) */
  enableGlowBlur?: boolean;
}

export const DEFAULT_CONFIG: Required<TailGradientConfig> = {
  windowGraphemes: 24,
  minOpacity: 0.16,
  maxOpacity: 0.88,
  enableGlowBlur: true,
};

/** 梯级透明度标定 (5 级非线性下凹衰减曲线) */
export const TIER_OPACITIES = [0.88, 0.68, 0.48, 0.3, 0.16] as const;

/** 梯级相对字素权重 (总和约为 1.0，越靠近末梢扩散宽度略宽) */
export const TIER_WEIGHTS = [0.18, 0.18, 0.2, 0.22, 0.22] as const;

/**
 * Unicode 字素安全切分
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
 * 将输入流式文本切分为稳定基底区与末端 5 阶衰减梯度
 * @param text 待处理的流式文本
 * @param enabled 是否开启渐变衰减 (false 时直接返回全量 solidPrefix)
 * @param config 配置参数
 */
export function partitionTailGradient(
  text: string,
  enabled: boolean = true,
  config: TailGradientConfig = {}
): TailGradientResult {
  if (!enabled || !text) {
    return { solidPrefix: text ?? '', tiers: [] };
  }

  // 短文本边界：长度 <= 4 字符时不切分，全量作为 solidPrefix 返回
  if (text.length <= 4) {
    return { solidPrefix: text, tiers: [] };
  }

  const { windowGraphemes, minOpacity, maxOpacity, enableGlowBlur } = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  // 为保证长文本 (如 100,000 字) 下仍为 O(1) 耗时，仅在末尾截取安全候选窗口
  // 一个字素最多占用约 12 个 UTF-16 code units (如复合 Emoji 序列)
  const candidateLength = Math.min(text.length, windowGraphemes * 6);
  let candidateOffset = text.length - candidateLength;

  // 避免将 candidateOffset 落在 UTF-16 代理对中间
  if (candidateOffset > 0) {
    const prevCode = text.charCodeAt(candidateOffset - 1);
    if (prevCode >= 0xd800 && prevCode <= 0xdbff) {
      candidateOffset -= 1;
    }
  }

  // 对末尾候选子串进行字素切分
  const candidateText = text.slice(candidateOffset);
  const candidateGraphemes = splitGraphemes(candidateText);

  // 获取最后 windowGraphemes 个字素
  const tailGraphemeCount = Math.min(
    candidateGraphemes.length,
    windowGraphemes
  );
  const tailGraphemes = candidateGraphemes.slice(
    candidateGraphemes.length - tailGraphemeCount
  );

  const tailText = tailGraphemes.join('');
  const solidPrefix = text.slice(0, text.length - tailText.length);

  const totalG = tailGraphemes.length;
  if (totalG === 0) {
    return { solidPrefix: text, tiers: [] };
  }

  // 字符过少 (<= 3) 时归为一个轻度渐隐梯级
  if (totalG <= 3) {
    return {
      solidPrefix,
      tiers: [
        {
          opacity: 0.35,
          text: tailText,
          hasGlow: enableGlowBlur,
          blurRadius: enableGlowBlur ? 2.5 : undefined,
        },
      ],
    };
  }

  // 当字素数量为 4 时，分配为 4 级单调递减梯级
  if (totalG === 4) {
    const opacities = [0.88, 0.68, 0.48, 0.22];
    return {
      solidPrefix,
      tiers: tailGraphemes.map((g, i) => ({
        opacity: opacities[i]!,
        text: g,
        hasGlow: enableGlowBlur && i >= 2,
        blurRadius: enableGlowBlur && i >= 2 ? 2.5 : undefined,
      })),
    };
  }

  // totalG >= 5：分配为 5 级梯级
  const opacities =
    config.minOpacity !== undefined || config.maxOpacity !== undefined
      ? [
          maxOpacity,
          Number((maxOpacity - (maxOpacity - minOpacity) * 0.25).toFixed(2)),
          Number((maxOpacity - (maxOpacity - minOpacity) * 0.5).toFixed(2)),
          Number((maxOpacity - (maxOpacity - minOpacity) * 0.72).toFixed(2)),
          minOpacity,
        ]
      : TIER_OPACITIES;

  // 按权重计算每个梯级的目标字素数量 (保底每级至少 1 字素)
  const counts = TIER_WEIGHTS.map((w) => Math.max(1, Math.round(totalG * w)));
  let currentSum = counts.reduce((sum, c) => sum + c, 0);

  // 调整梯级字素总和以精确匹配 totalG (守恒约束)
  while (currentSum < totalG) {
    // 优先加到末梢梯级，增强朦胧扩散区域
    for (let i = counts.length - 1; i >= 0 && currentSum < totalG; i--) {
      counts[i] = (counts[i] ?? 0) + 1;
      currentSum++;
    }
  }
  while (currentSum > totalG) {
    // 从前半段字素数 > 1 的梯级削减
    for (let i = 0; i < counts.length && currentSum > totalG; i++) {
      if ((counts[i] ?? 0) > 1) {
        counts[i] = (counts[i] ?? 0) - 1;
        currentSum--;
      }
    }
  }

  const tiers: GradientTier[] = [];
  let allocated = 0;
  for (let i = 0; i < counts.length; i++) {
    const count = counts[i]!;
    const tierSlice = tailGraphemes.slice(allocated, allocated + count);
    allocated += count;

    if (tierSlice.length > 0) {
      tiers.push({
        opacity: opacities[i]!,
        text: tierSlice.join(''),
        hasGlow: enableGlowBlur && i >= 3,
        blurRadius: enableGlowBlur && i >= 3 ? 2.5 : undefined,
      });
    }
  }

  return { solidPrefix, tiers };
}
