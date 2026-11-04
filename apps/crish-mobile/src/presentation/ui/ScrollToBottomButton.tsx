// 回到底部悬浮按钮：仅在离开底部时出现。符号化正圆按钮（用户裁决：改成符号，放在输入框左上角）。
// 浮层阴影（容器外阴影批，2026-11-02）：悬浮按钮走 SoftShadowSurface button 档
// （--btn-shadow），仅 Android 浅色渲染；出现/消失走 150ms 淡入淡出、
// 按压整件透明度 120ms 过渡（按压过渡统一批）。
// 圆角铁律（圆形按钮缺陷审计）：Ø36dp 正圆圆角恒为 BUTTON_SIZE / 2 实值（18dp），
// 严禁使用 radius.pill 避免 Android 八边形阴影畸变。
// 触控热区：hitSlop 补足至 44dp 满足无障碍触控标准。
// 键盘解耦（Wave 4 裁决，2026-11-04）：彻底废除 followKeyboard 上推位移，
// 软键盘弹起前 40dp 原地平滑淡出至 0 并置 pointerEvents="none"，打字态静默避让；
// 按钮底距纯静态锚定输入框（overlayHeight + 8dp）。
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
  /** 底部偏移（Tab 页传 tabBar 高度 + 安全区；详情页传 overlayHeight + 8） */
  bottomOffset?: number;
  /** 水平对齐模式：'left' 为输入框左上角（默认对齐 16dp），'center' 为通用居中 */
  alignment?: 'left' | 'center';
  /** 左侧偏移（alignment='left' 时生效，缺省为 insets.left + theme.space.lg） */
  leftOffset?: number;
  /**
   * 软键盘弹起时是否自动原地淡出隐藏（打字解耦铁律，2026-11-04 用户裁决）：
   * 键盘升起时按钮在原位平滑淡出并禁用触摸，绝不上推遮挡视觉与输入；
   * 缺省开启（true）；收起后平滑恢复。
   */
  hideOnKeyboard?: boolean;
  /**
   * @deprecated 已废弃。根据用户裁决，打字态下按钮绝不上推，统一走原地静默淡出。
   * @see hideOnKeyboard
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
  hideOnKeyboard = true,
  followKeyboard: _deprecatedFollowKeyboard,
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

  // 键盘解耦动效 Worklet：键盘升起时原地淡出至 0，绝不上移推高；收起后恢复
  const keyboardFadeStyle = useAnimatedStyle(() => {
    'worklet';
    if (!hideOnKeyboard) return {};
    // keyboard.height.value <= 0 (0 = 完全收起, -336 = 完全升起)
    // 在键盘弹起最初 40dp 范围平滑插值淡出
    const kbHeight = -keyboard.height.value;
    const opacity = kbHeight <= 0 ? 1 : Math.max(0, 1 - kbHeight / 40);
    return {
      opacity,
      pointerEvents: opacity <= 0 ? 'none' : 'box-none',
    };
  });

  const positionStyle: ViewStyle =
    alignment === 'left'
      ? { bottom: baseBottom, left: baseLeft }
      : { bottom: baseBottom, alignSelf: 'center' };

  return (
    <Animated.View
      entering={FadeIn.duration(theme.motion.duration.fast)}
      exiting={FadeOut.duration(theme.motion.duration.snappy)}
      style={[styles.host, keyboardFadeStyle]}
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
        style={[styles.button, positionStyle, press.fadeStyle]}
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
