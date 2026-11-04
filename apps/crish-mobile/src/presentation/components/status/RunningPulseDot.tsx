// 运行中呼吸点（S4）：状态点以 1.6s 周期做透明度呼吸，与桌面共享
// pulse 口径（crish-pulse-dot，1.6s）对齐——长时间运行时静止画面与
// 「已卡死」难以区分，呼吸点是唯一的动态凭据。纪律同桌面：只有
// 「当前运行」的那一个点在呼吸，其余状态点（完成/待审批等，仍走
// Badge 静态点）保持静止；系统 Reduce Motion 开启时静态呈现（共享
// 信号 useReducedMotion，禁另起探测）。
import { useEffect } from 'react';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import { useReducedMotion } from '@/adapters/platform/useReducedMotion';

/** 呼吸周期（ms）：与桌面 1.6s 呼吸点同值 */
export const RUNNING_PULSE_PERIOD_MS = 1600;
/** 呼吸谷值不透明度：只变淡不消失，状态点身份恒在 */
const PULSE_MIN_OPACITY = 0.35;

export interface RunningPulseDotProps {
  /** 直径（dp），默认与既有状态点同档 7 */
  size?: number;
  /** 点色覆盖（默认品牌色，与 Badge accent 同源） */
  color?: string;
  testID?: string;
}

export function RunningPulseDot({
  size = 7,
  color,
  testID,
}: RunningPulseDotProps) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) {
      // 静态呈现：停在满不透明度（赋值即终止可能在跑的动画）
      pulse.value = 0;
      return;
    }
    pulse.value = withRepeat(
      withTiming(1, {
        duration: RUNNING_PULSE_PERIOD_MS / 2,
        easing: Easing.inOut(Easing.ease),
      }),
      -1,
      true
    );
    return () => cancelAnimation(pulse);
  }, [pulse, reduceMotion]);
  const style = useAnimatedStyle(() => ({
    opacity: 1 - (1 - PULSE_MIN_OPACITY) * pulse.value,
  }));
  return (
    <Animated.View
      testID={testID}
      style={[
        {
          width: size,
          height: size,
          // 圆盘圆角用直径/2 实值（theme 口径：正方形圆盘禁用 pill 档）
          borderRadius: size / 2,
          backgroundColor: color ?? theme.colors.brand,
        },
        style,
      ]}
    />
  );
}

export default RunningPulseDot;
