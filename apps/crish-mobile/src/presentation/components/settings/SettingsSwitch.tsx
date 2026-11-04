// 自绘开关（原型 crish-switch）：轨道 44×26、圆钮 20（内衬 3），
// 关轨 borderStrong(#e5e5e5)、开轨 brand 绿，0.2s emphasized 曲线滑动。
// 替代 RN 原生 Switch（双端渲染不一致、无原型口径），动画走 Reanimated UI 线程。
import { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import { haptics } from '@/adapters/platform/haptics';

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
      onPress={() => {
        // 选择 tick 与开关滑动同帧（触觉门面语义：selection，手感基建批）
        haptics.selection();
        onValueChange(!value);
      }}
      style={disabled ? styles.disabled : undefined}
    >
      <Animated.View
        style={[styles.track, { borderRadius: theme.radius.pill }, trackStyle]}
      >
        <Animated.View style={[styles.knob, knobStyle]}>
          {/* 旋钮填充碟：单层、圆角 KNOB_SIZE / 2 实值（圆形按钮定案）。原底层
              影碟已随去阴影裁决（2026-11-02）整节点删除——它仅承载阴影、白色
              填充与本碟同色且被完全遮挡；旋钮现靠轨道色差区分。 */}
          <View
            style={[
              styles.knobDisc,
              {
                borderRadius: KNOB_SIZE / 2,
                // 圆钮恒白（双主题同值 token：主操作上的文字白）
                backgroundColor: theme.colors.actionPrimaryText,
              },
            ]}
          />
        </Animated.View>
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
  // 旋钮填充碟：绝对铺满旋钮盒
  knobDisc: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: KNOB_SIZE,
    height: KNOB_SIZE,
  },
  disabled: { opacity: 0.5 },
});

export default SettingsSwitch;
