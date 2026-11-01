// 自绘开关（原型 crish-switch）：轨道 44×26、圆钮 20（内衬 3），
// 关轨 borderStrong(#e5e5e5)、开轨 brand 绿，0.2s emphasized 曲线滑动。
// 替代 RN 原生 Switch（双端渲染不一致、无原型口径），动画走 Reanimated UI 线程。
import { useEffect } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Animated, {
  Easing,
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';

export interface SettingsSwitchProps {
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  testID?: string;
  accessibilityLabel?: string;
}

const TRACK_WIDTH = 44;
const TRACK_HEIGHT = 26;
const KNOB_SIZE = 20;
const KNOB_INSET = 3;
const KNOB_TRAVEL = TRACK_WIDTH - KNOB_SIZE - KNOB_INSET * 2;

export function SettingsSwitch({
  value,
  onValueChange,
  disabled = false,
  testID,
  accessibilityLabel,
}: SettingsSwitchProps) {
  const theme = useTheme();
  const progress = useSharedValue(value ? 1 : 0);

  useEffect(() => {
    progress.value = withTiming(value ? 1 : 0, {
      duration: theme.motion.duration.normal,
      easing: Easing.bezier(...theme.motion.easing.emphasized),
    });
  }, [value, progress, theme.motion]);

  const trackStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      progress.value,
      [0, 1],
      [theme.colors.borderStrong, theme.colors.brand]
    ),
  }));

  const knobStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: interpolate(progress.value, [0, 1], [0, KNOB_TRAVEL]) },
    ],
  }));

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      testID={testID}
      hitSlop={{ top: 9, bottom: 9 }}
      onPress={() => onValueChange(!value)}
      style={disabled ? styles.disabled : undefined}
    >
      <Animated.View
        style={[styles.track, { borderRadius: theme.radius.pill }, trackStyle]}
      >
        <Animated.View
          style={[
            styles.knob,
            theme.shadow.sm,
            {
              borderRadius: theme.radius.pill,
              // 圆钮恒白（双主题同值 token：主操作上的文字白）
              backgroundColor: theme.colors.actionPrimaryText,
              shadowOpacity: theme.dark ? theme.shadow.sm.shadowOpacity : 0.15,
            },
            knobStyle,
          ]}
        />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: {
    width: TRACK_WIDTH,
    height: TRACK_HEIGHT,
    justifyContent: 'center',
  },
  knob: {
    width: KNOB_SIZE,
    height: KNOB_SIZE,
    marginLeft: KNOB_INSET,
  },
  disabled: { opacity: 0.5 },
});

export default SettingsSwitch;
