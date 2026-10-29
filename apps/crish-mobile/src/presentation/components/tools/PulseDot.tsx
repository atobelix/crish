// 运行中脉冲点（brand 色，透明度往复）；减弱动态效果时保持静止。
import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, StyleSheet } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';

export interface PulseDotProps {
  testID?: string;
}

export function PulseDot({ testID }: PulseDotProps) {
  const theme = useTheme();
  const opacity = useRef(new Animated.Value(1)).current;
  const duration = theme.motion.duration.sheet;
  useEffect(() => {
    let loop: Animated.CompositeAnimation | null = null;
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (cancelled || reduced) return;
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(opacity, {
            toValue: 0.35,
            duration: duration * 3,
            useNativeDriver: true,
          }),
          Animated.timing(opacity, {
            toValue: 1,
            duration: duration * 3,
            useNativeDriver: true,
          }),
        ])
      );
      loop.start();
    });
    return () => {
      cancelled = true;
      loop?.stop();
    };
  }, [opacity, duration]);
  return (
    <Animated.View
      testID={testID}
      style={[
        styles.dot,
        {
          width: theme.size.dot,
          height: theme.size.dot,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.colors.brand,
          opacity,
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  dot: { flexShrink: 0 },
});

export default PulseDot;
