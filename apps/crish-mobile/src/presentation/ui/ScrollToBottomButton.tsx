// 回到底部悬浮按钮：仅在离开底部时出现。符号化正圆按钮（用户裁决：改成符号，放在输入框左上角）。
// 浮层阴影（容器外阴影批，2026-11-02）：悬浮按钮走 SoftShadowSurface button 档
// （--btn-shadow），仅 Android 浅色渲染；出现/消失走 150ms 淡入淡出、
// 按压整件透明度 120ms 过渡（按压过渡统一批）。
// 圆角铁律（圆形按钮缺陷审计）：Ø36dp 正圆圆角恒为 BUTTON_SIZE / 2 实值（18dp），
// 严禁使用 radius.pill 避免 Android 八边形阴影畸变。
// 触控热区：hitSlop 补足至 44dp 满足无障碍触控标准。
import { useCallback } from 'react';
import { StyleSheet, type ViewStyle } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
} from 'react-native-reanimated';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import { haptics } from '@/adapters/platform/haptics';
import Icon from './Icon';
import { SoftShadowSurface } from './SoftShadowSurface';
import { AnimatedPressable, usePressFade } from './pressFeedback';

export interface ScrollToBottomButtonProps {
  onPress: () => void;
  /** 底部偏移（Tab 页传 tabBar 高度 + 安全区；详情页传 floatingHeight + 8） */
  bottomOffset?: number;
  /** 水平对齐模式：'left' 为输入框左上角（默认对齐 16dp），'center' 为通用居中 */
  alignment?: 'left' | 'center';
  /** 左侧偏移（alignment='left' 时生效，缺省为 insets.left + theme.space.lg） */
  leftOffset?: number;
  /**
   * 底距跟随键盘逐帧值（批 B ㉔）：键盘升起时按钮同步上浮键盘高度，
   * 与 Composer 同吃 keyboard-controller 逐帧高度（单时钟源口径，
   * 批 A 成文）；缺省关闭——其他宿主维持静态底距。
   */
  followKeyboard?: boolean;
  testID?: string;
}

const BUTTON_SIZE = 36;
const BUTTON_RADIUS = BUTTON_SIZE / 2;

export function ScrollToBottomButton({
  onPress,
  bottomOffset,
  alignment = 'left',
  leftOffset,
  followKeyboard = false,
  testID,
}: ScrollToBottomButtonProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const press = usePressFade();
  const keyboard = useReanimatedKeyboardAnimation();
  const baseBottom = bottomOffset ?? insets.bottom + 24;
  const baseLeft = leftOffset ?? insets.left + theme.space.lg;

  const hitSlop = Math.max(0, (theme.size.touch - BUTTON_SIZE) / 2);

  const handlePress = useCallback(() => {
    haptics.tap();
    onPress();
  }, [onPress]);

  // keyboard.height.value ≤ 0（0 = 收起 → −键盘高 = 升起），底距 =
  // 静态底距 + 键盘高度；followKeyboard 关闭时返回空样式，静态底距生效
  const keyboardFollowStyle = useAnimatedStyle(() => {
    'worklet';
    if (!followKeyboard) return {};
    return { bottom: baseBottom - keyboard.height.value };
  });

  const positionStyle: ViewStyle =
    alignment === 'left'
      ? { bottom: baseBottom, left: baseLeft }
      : { bottom: baseBottom, alignSelf: 'center' };

  return (
    <Animated.View
      entering={FadeIn.duration(theme.motion.duration.fast)}
      exiting={FadeOut.duration(theme.motion.duration.snappy)}
      style={styles.host}
      pointerEvents="box-none"
    >
      <AnimatedPressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel="回到底部"
        accessibilityHint="双击立即快速滚动到消息流最底部"
        hitSlop={{
          top: hitSlop,
          bottom: hitSlop,
          left: hitSlop,
          right: hitSlop,
        }}
        onPress={handlePress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={[
          styles.button,
          positionStyle,
          press.fadeStyle,
          keyboardFollowStyle,
        ]}
      >
        <SoftShadowSurface
          preset="button"
          width={BUTTON_SIZE}
          height={BUTTON_SIZE}
          borderRadius={BUTTON_RADIUS}
          fill={theme.colors.surfaceRaised}
          fillStyle={styles.surfaceFill}
        >
          <Icon
            name="chevron-down"
            size={18}
            color={theme.colors.textPrimary}
          />
        </SoftShadowSurface>
      </AnimatedPressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // 外壳全屏覆盖但不拦触摸：承接 entering/exiting 与按钮的绝对定位锚点，
  // 不改变宿主列表的原有布局
  host: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  button: {
    position: 'absolute',
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
  },
  surfaceFill: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default ScrollToBottomButton;
