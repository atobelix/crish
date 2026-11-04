// 回到底部悬浮按钮：仅在离开底部时出现。纯色胶囊（N05：文字已足够，删除箭头与发丝描边）。
// 浮层阴影（容器外阴影批，2026-11-02）：悬浮胶囊走 SoftShadowSurface button 档
// （--btn-shadow），仅 Android 浅色渲染；出现/消失走 150ms 淡入淡出、
// 按压整件透明度 120ms 过渡（按压过渡统一批）。
import { StyleSheet } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
} from 'react-native-reanimated';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import AppText from './AppText';
import { SoftShadowSurface } from './SoftShadowSurface';
import { AnimatedPressable, usePressFade } from './pressFeedback';

export interface ScrollToBottomButtonProps {
  onPress: () => void;
  /** 底部偏移（Tab 页传 tabBar 高度 + 安全区；详情页默认 24） */
  bottomOffset?: number;
  /**
   * 底距跟随键盘逐帧值（批 B ㉔）：键盘升起时按钮同步上浮键盘高度，
   * 与 Composer 同吃 keyboard-controller 逐帧高度（单时钟源口径，
   * 批 A 成文）；缺省关闭——其他宿主维持静态底距。
   */
  followKeyboard?: boolean;
  testID?: string;
}

export function ScrollToBottomButton({
  onPress,
  bottomOffset,
  followKeyboard = false,
  testID,
}: ScrollToBottomButtonProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const press = usePressFade();
  const keyboard = useReanimatedKeyboardAnimation();
  const baseBottom = bottomOffset ?? insets.bottom + 24;
  // keyboard.height.value ≤ 0（0 = 收起 → −键盘高 = 升起），底距 =
  // 静态底距 + 键盘高度；followKeyboard 关闭时返回空样式，静态底距生效
  const keyboardFollowStyle = useAnimatedStyle(() => {
    'worklet';
    if (!followKeyboard) return {};
    return { bottom: baseBottom - keyboard.height.value };
  });
  return (
    <Animated.View
      entering={FadeIn.duration(theme.motion.duration.fast)}
      exiting={FadeOut.duration(theme.motion.duration.fast)}
      style={styles.host}
      pointerEvents="box-none"
    >
      <AnimatedPressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel="回到底部"
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={[
          styles.button,
          {
            bottom: baseBottom,
          },
          press.fadeStyle,
          keyboardFollowStyle,
        ]}
      >
        <SoftShadowSurface
          preset="button"
          borderRadius={theme.radius.pill}
          fill={theme.colors.surfaceRaised}
          fillStyle={{
            minHeight: 36,
            paddingHorizontal: 14,
            flexDirection: 'row',
            alignItems: 'center',
          }}
        >
          <AppText variant="footnote" color="textPrimary">
            回到底部
          </AppText>
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
    alignSelf: 'center',
  },
});

export default ScrollToBottomButton;
