// 触控热区工具（R2-05k / A1 裁决双轨：iOS 44pt 视觉下限 + Android 48dp 命中热区）
// - dualHitSlop：按视觉尺寸补足 HitSlop 到双轨目标（iOS 44 / Android 48），视觉不变、热区扩展
// - 单边扩展 = ceil((目标 − 视觉) / 2)；全向达标（各边均无需补足）返回 undefined 免设 hitSlop
import { Platform } from 'react-native';
import type { Insets } from 'react-native';

// iOS 触控目标下限（HIG 44pt）/ Android 命中热区目标（M3 48dp）
const TARGET_IOS = 44;
const TARGET_ANDROID = 48;

// 单边补足量：视觉尺寸达到目标返回 0，否则向上取整平分差值
function padToTarget(visual: number, target: number): number {
  if (visual >= target) {
    return 0;
  }
  return Math.ceil((target - visual) / 2);
}

// 双轨 HitSlop：宽缺省同高（仅传一个尺寸时按正方形处理）；
// iOS 补足 44pt、Android 补足 48dp；全向达标返回 undefined（免设 hitSlop）
export function dualHitSlop(
  height: number,
  width?: number
): Insets | undefined {
  const visualWidth = width ?? height;
  const target = Platform.OS === 'android' ? TARGET_ANDROID : TARGET_IOS;
  const top = padToTarget(height, target);
  const bottom = top;
  const left = padToTarget(visualWidth, target);
  const right = left;
  if (top === 0 && left === 0) {
    return undefined;
  }
  return { top, bottom, left, right };
}
