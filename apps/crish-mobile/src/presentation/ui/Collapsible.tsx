// 上方行收展原语（批 A，2026-11-03；深比 01-8 的 Cherry Collapsible
// 口径落地）：composer 上方行（附件条 / 附件菜单等）的进出场统一走本
// 原语，不再条件渲染硬切。
// - 高度由共享值直驱（progress × 实测内容高），不用 layout animation：
//   布局动画会让宿主表面先跳到终高、行再滑入；直驱才让整个悬浮区随行
//   一起 reflow（宿主的悬浮高实测链因此逐帧跟随，见 BOTTOM-INSET）；
// - 高度与 opacity 同一条配对（theme.motion.duration.settle +
//   emphasized）：淡入比高度快会留下一个空盒子在收展，禁止两条节奏；
// - 关闭时保留最后一帧内容直到缩完才卸载；实测高 ±抖动不重启画
//   （高度状态只在变化时提交）；
// - 减动效：进度直达终值，不补间。
import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import { useReducedMotion } from '@/adapters/platform/useReducedMotion';

export interface CollapsibleProps {
  visible: boolean;
  children: ReactNode;
  testID?: string;
}

export function Collapsible({ visible, children, testID }: CollapsibleProps) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const [mounted, setMounted] = useState(visible);
  const [contentHeight, setContentHeight] = useState(0);
  const progress = useSharedValue(visible ? 1 : 0);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      if (reduceMotion) {
        progress.value = 1;
      } else {
        progress.value = withTiming(1, {
          duration: theme.motion.duration.settle,
          easing: Easing.bezier(...theme.motion.easing.emphasized),
        });
      }
      return;
    }
    if (reduceMotion) {
      progress.value = 0;
      setMounted(false);
      return;
    }
    progress.value = withTiming(
      0,
      {
        duration: theme.motion.duration.settle,
        easing: Easing.bezier(...theme.motion.easing.emphasized),
      },
      (finished) => {
        if (finished) runOnJS(setMounted)(false);
      }
    );
    // 兜底卸载：动画被打断/测试环境回调不达时不留挂载（同 Sheet 先例）
    const timer = setTimeout(() => setMounted(false), 400);
    return () => clearTimeout(timer);
  }, [visible, reduceMotion]);

  const containerStyle = useAnimatedStyle(() => ({
    height: progress.value * contentHeight,
    opacity: progress.value,
  }));

  const handleLayout = (event: LayoutChangeEvent) => {
    const next = Math.ceil(event.nativeEvent.layout.height);
    // ±1px 测量抖动不提交（防逐帧重启画，与 Cherry Collapsible 同规）
    setContentHeight((prev) => (Math.abs(prev - next) > 1 ? next : prev));
  };

  if (!mounted) return null;
  return (
    <Animated.View
      testID={testID}
      pointerEvents={visible ? 'auto' : 'none'}
      style={[styles.clip, containerStyle]}
    >
      <View onLayout={handleLayout}>{children}</View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  clip: {
    overflow: 'hidden',
  },
});

export default Collapsible;
