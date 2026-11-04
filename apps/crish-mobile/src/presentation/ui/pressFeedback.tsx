// 按压反馈共享原语（按压过渡统一批，2026-11-02）：
// 全 App 按压纪律（IconButton / ListRow pressProgress 先例的抽编收口）：
// 按压引起的亮度 / 透明度 / 缩放变化必须带 120ms（duration.snappy）过渡，
// 禁止瞬时换色、瞬时跳透明、瞬时跳缩放。此前各组件散落的
// `pressed && { opacity }` / `pressed ? bg : bg` 写法由本模块统一取代。
// - usePressFade：按压进度 shared value + 三种消费形态的 animated style：
//   · overlayStyle  叠层淡入淡出——宿主常驻填充 + 绝对定位着色层（ListRow 模式）
//   · fadeStyle     整件透明度 1→motion.pressOpacity——透明底 / 异色底元素用
//   · pressScaleStyle 整件缩放 1→motion.pressScale——发送盘等强调钮用
// - AnimatedPressable：模块级 createAnimatedComponent(Pressable)。fade / scale
//   模式宿主用它承载 animated style（组件标识必须模块级稳定，运行时重建会
//   丢动画节点）。
import { useCallback } from 'react';
import { Pressable } from 'react-native';
import type { ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type AnimatedStyle,
} from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';

export const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export interface PressFade {
  /** 挂到 Pressable 的 onPressIn / onPressOut */
  onPressIn: () => void;
  onPressOut: () => void;
  /** 叠层模式：透明度 0→1（宿主常驻填充，本层绝对定位着色） */
  overlayStyle: AnimatedStyle<ViewStyle>;
  /** 整件模式：透明度 1→motion.pressOpacity */
  fadeStyle: AnimatedStyle<ViewStyle>;
  /** 整件模式：缩放 1→motion.pressScale */
  pressScaleStyle: AnimatedStyle<ViewStyle>;
}

export function usePressFade(): PressFade {
  const theme = useTheme();
  const progress = useSharedValue(0);
  const duration = theme.motion.duration.snappy;
  const pressOpacity = theme.motion.pressOpacity;
  const pressScale = theme.motion.pressScale;
  const onPressIn = useCallback(() => {
    progress.value = withTiming(1, { duration });
  }, [progress, duration]);
  const onPressOut = useCallback(() => {
    progress.value = withTiming(0, { duration });
  }, [progress, duration]);
  const overlayStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
  }));
  const fadeStyle = useAnimatedStyle(() => ({
    opacity: 1 - progress.value * (1 - pressOpacity),
  }));
  const pressScaleStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - progress.value * (1 - pressScale) }],
  }));
  return { onPressIn, onPressOut, overlayStyle, fadeStyle, pressScaleStyle };
}
