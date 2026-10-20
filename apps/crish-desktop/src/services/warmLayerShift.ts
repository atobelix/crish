/**
 * warmLayerShift — 三档底色的亮度微调：只平移 CMYK 的 K，保持每层自身的 C/M/Y（review P1-3）。
 *
 * 做法：K-only 变化在 RGB 里等价于三通道同比例缩放：RGB' = RGB × (1 − K') / (1 − K)，
 * 所以浅色暖灰的 M0.4/Y0.8 在任何档位都保持（深色本来就是中性，保持中性）。
 * 三层同步平移（每档 STEP_K 个 K 点），再夹紧，保证相邻两层至少差 MIN_GAP_K：
 *   - 浅色：外层 K > 主层 K > 输入框 K（输入框恒为纯白 K0，heson 定稿）；
 *   - 深色：主层 K > 外层 K > 输入框 K（主层沉底偏黑、外层侧栏居中、输入框/卡片微亮浮层），任何档位都不反转、不贴合。
 */
export interface WarmLayers {
  outer: string;
  main: string;
  input: string;
}

/** 每档亮度微调平移的 K 点数（与原主层斜率 0.6 L/档同量级） */
export const STEP_K = 0.6;
/** 相邻两层的最小 K 差（≈ 3 个 8-bit 单位，肉眼可辨） */
export const MIN_GAP_K = 1.2;

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  const v =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)) as Rgb;
}

function rgbToHex([r, g, b]: Rgb): string {
  return (
    '#' +
    [r, g, b]
      .map((c) =>
        Math.max(0, Math.min(255, Math.round(c)))
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
  );
}

/** CMYK 的 K（0–100） */
export function kOf(hex: string): number {
  return (1 - Math.max(...hexToRgb(hex)) / 255) * 100;
}

/** 把颜色平移到指定 K（保持 C/M/Y） */
export function withK(hex: string, k: number): string {
  const rgb = hexToRgb(hex);
  const from = 1 - kOf(hex) / 100;
  const to = 1 - k / 100;
  if (from <= 0) return rgbToHex([255 * to, 255 * to, 255 * to]);
  return rgbToHex(rgb.map((c) => (c * to) / from) as Rgb);
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/**
 * @param base   adjust = 0 时的三档 hex（外层 / 主层 / 输入框）
 * @param adjust 亮度微调档位（正 = 更亮，负 = 更暗；可为小数）
 * @param isDark 深色模式（输入框参与平移；浅色输入框固定纯白）
 */
export function shiftWarmLayers(
  base: WarmLayers,
  adjust: number,
  isDark: boolean
): WarmLayers {
  if (!adjust) return { ...base };
  const d = -adjust * STEP_K; // 更亮 = K 变小
  if (isDark) {
    // 深色：主层偏黑沉底（K 最大）> 外层侧栏偏灰（K 居中）> 输入框/卡片微亮（K 最小）
    const kIn0 = kOf(base.input);
    const kInput = clamp(kIn0 + d, 0, 100 - 3 * MIN_GAP_K);
    const kOuter = clamp(
      kOf(base.outer) + d,
      kInput + MIN_GAP_K,
      100 - 2 * MIN_GAP_K
    );
    const kMain = clamp(
      kOf(base.main) + d,
      kOuter + MIN_GAP_K,
      100 - MIN_GAP_K
    );
    return {
      outer: withK(base.outer, kOuter),
      main: withK(base.main, kMain),
      input: withK(base.input, kInput),
    };
  } else {
    // 浅色：外层偏灰（K 最大）> 主层亮白（K 居中）> 输入框纯白（K=0）
    const kIn0 = kOf(base.input);
    const kInput = kIn0;
    // 当主层与输入层同色（如浅色纯白模式 #ffffff）时，主层下限即为 kInput (0)，避免正向调亮反遭 1.2K 垫底加深
    const minMainK = base.main === base.input ? kInput : kInput + MIN_GAP_K;
    const kMain = clamp(kOf(base.main) + d, minMainK, 100 - 2 * MIN_GAP_K);
    const kOuter = clamp(
      kOf(base.outer) + d,
      kMain + MIN_GAP_K,
      100 - MIN_GAP_K
    );
    return {
      outer: withK(base.outer, kOuter),
      main: withK(base.main, kMain),
      input: base.input,
    };
  }
}
