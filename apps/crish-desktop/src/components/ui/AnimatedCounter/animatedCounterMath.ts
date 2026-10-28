import type { FormattedPart } from './types';

/**
 * 逆向位权建模（Place-value Keying）：
 * 将数值通过 Intl.NumberFormat 分词，并赋予反向位权 key：
 * 整数部分：个位恒为 i0，十位恒为 i1，百位恒为 i2，千位为 i3...
 * 小数部分：f0, f1...
 * 千分位分隔符：以其左侧高位位权命名，如 g3（第 3 位千分符）。
 *
 * 保证 999 进位到 1,000 时，低位组件实例不被卸载/重新挂载，实现零抖动复用。
 */
export function partsFor(
  value: number,
  decimals: number = 0,
  locale: string = 'en-US'
): FormattedPart[] {
  const parts = new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    numberingSystem: 'latn',
  }).formatToParts(Math.abs(value));

  // 计算整数总位数，作为逆向位权起点
  let place = parts.reduce(
    (count, part) => count + (part.type === 'integer' ? part.value.length : 0),
    0
  );
  let fraction = 0;
  let order = 0;

  return parts.flatMap((part, index): FormattedPart[] => {
    if (part.type === 'integer') {
      return [...part.value].map((char) => ({
        type: 'digit',
        key: `i${--place}`,
        digit: Number(char),
        order: order++,
      }));
    }
    if (part.type === 'fraction') {
      return [...part.value].map((char) => ({
        type: 'digit',
        key: `f${fraction++}`,
        digit: Number(char),
        order: order++,
      }));
    }
    return [
      {
        type: 'symbol',
        key:
          part.type === 'group'
            ? `g${place}`
            : part.type === 'decimal'
              ? 'd'
              : `${part.type}-${index}`,
        text: part.value,
      },
    ];
  });
}

/**
 * 环形滚轮模运算映射公式：
 * offset = ((((digit - position) % 10) + 15) % 10) - 5
 * 将任何浮点位置与字形距离对称映射到 [-5, +4] 对称区间内。
 */
export function calculateGlyphOffset(digit: number, position: number): number {
  return ((((digit - position) % 10) + 15) % 10) - 5;
}

/**
 * 里程表方向增量步进：
 * 根据全局递增/递减方向，计算当前列在 0~9 环形滚轮上的单调递增/递减增量。
 *
 * @param currentDigit 当前列停靠的数字 (0~9)
 * @param targetDigit 目标数字 (0~9)
 * @param direction 全局运动方向：>=0 为顺时针递增，<0 为逆时针递减
 */
export function calculateOdometerDelta(
  currentDigit: number,
  targetDigit: number,
  direction: number
): number {
  if (direction < 0) {
    return -((currentDigit - targetDigit + 10) % 10);
  }
  return (targetDigit - currentDigit + 10) % 10;
}
