// 图标按钮：44 触控目标。
// - plain：透明底圆钮，按压以 fillPressed 叠层 120ms 淡入淡出。
// - floating：38 圆（原型白圆钮口径；个别场景以 diameter 覆盖回 40，如抽屉顶部动作钮），
//   磨砂玻璃底（J7 通透质感）：iOS 走 BlurView（强度 40，与 GlassBackdrop 同口径）叠 glass 半透明色；
//   Android 浅色走半透明白（rgba(255,255,255,0.82)）+ SoftShadow SVG 软阴影，
//   叠在 #f5f5f5 抽屉背景上合成约 #fdfdfd，产生通透的层次感。hitSlop 补足 44 触控。
// - floating 的 tone='step'：A2「亮度台阶盘 · 无影版」（返回钮选型定案
//   2026-11-02，方案见 crish-mobile-plan/back-button-design/A2实施方案.md）：
//   Ø40、填充 canvasDrawer 实色（浅 #f5f5f5 / 深 #0e0e0e，与抽屉底共用同一
//   台阶 token）、无模糊、不渲染 SoftShadow（floating 的无影 tone 即此档），
//   按压叠层走 fillPressed；默认 tone='glass' 同走 fillPressed。
//
// 圆盘结构（圆形按钮缺陷审计定案，2026-11-02）：圆角一律 直径/2 实值——禁用
// radius.pill 的 9999：极端圆角与原生阴影压在同一节点时，Android 的填充轮廓与
// 阴影轮廓走两条原生路径、一条退化成八边形，叠印成「外圆内八角」。填充 / 模糊 /
// 按压叠层各占独立一层。
// 阴影口径（SVG 软阴影收编定案，2026-11-02）：全 App 唯一阴影路径 = SoftShadow
// （仅 Android + 浅色主题时渲染，原型 --btn-shadow 两层规格）；原生阴影一律
// 禁用——Android 的 elevation 无任何来源设值，连 0 的字面量展开也不留（死代码），
// iOS 的 shadow* 同禁。深色主题不渲染阴影（黑 α1.2% 在深色上 Δ≈0.3、物理不
// 可见，原型亦无深色规格），区分回归亮度台阶（填充 surfaceRaised）；iOS 无
// 阴影（如实登记），区分靠 BlurView 玻璃 / surfaceRaised 填充。
// 按压反馈一律走叠层不透明度的 120ms 过渡（duration.snappy，与原型 0.12s 对齐），禁止瞬时换色。
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import AppText from './AppText';
import Icon, { type IconName } from './Icon';
import { SoftShadow } from './SoftShadow';

export type IconButtonVariant = 'plain' | 'floating';
export type IconButtonTone = 'glass' | 'step';

export interface IconButtonProps {
  name: IconName;
  onPress: () => void;
  accessibilityLabel: string;
  variant?: IconButtonVariant;
  /** floating 填充面孔：glass 磨砂（默认）/ step 台阶盘（A2 返回钮） */
  tone?: IconButtonTone;
  /** 右上角数字角标（0 / undefined 不显示） */
  badge?: number;
  badgeCap?: number;
  /** 圆钮直径覆盖（floating 默认 = size.iconButton − 2 = 38；step 档默认 = size.iconButton = 40） */
  diameter?: number;
  size?: number;
  color?: string;
  disabled?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

export function IconButton({
  name,
  onPress,
  accessibilityLabel,
  variant = 'plain',
  tone = 'glass',
  badge,
  badgeCap = 99,
  diameter: diameterOverride,
  size,
  color,
  disabled = false,
  testID,
  style,
}: IconButtonProps) {
  const theme = useTheme();
  const showBadge = typeof badge === 'number' && badge > 0;
  const floating = variant === 'floating';
  const diameter =
    diameterOverride ??
    (tone === 'step'
      ? theme.size.iconButton
      : floating
        ? theme.size.iconButton - 2
        : theme.size.touch);
  // 圆盘圆角恒为直径一半的实值（见文件头定案），胶囊专用的 pill 不得用于方盘
  const discRadius = diameter / 2;
  // floating 圆钮小于 44，用 hitSlop 把触控区补到 44
  const hitSlop = Math.max(0, (theme.size.touch - diameter) / 2);
  const iosBlur = floating && tone === 'glass' && Platform.OS === 'ios';
  // 按压叠层：填充色恒定（fillPressed，glass 与 step 同口径）、不透明度
  // 120ms 过渡（按下淡入 / 抬起淡出）
  const pressedFill = theme.colors.fillPressed;
  const pressProgress = useSharedValue(0);
  const pressOverlayStyle = useAnimatedStyle(() => ({
    opacity: pressProgress.value,
  }));

  // Android + 浅色 + glass 面孔的圆盘底色：半透明白（0.82）叠在 #f5f5f5 背景
  // 上合成约 #fdfdfd，产生通透层次感；iOS 玻璃端由 BlurView + glass 叠层
  // 承担，本值不生效。
  const androidGlassFill = 'rgba(255,255,255,0.82)';

  // 填充节点底色（圆盘填充的单一绘制点；SoftShadow 只画阴影、不绘填充）：
  // step 台阶盘全平台全主题走 canvasDrawer 实色；仅 Android 浅色 glass
  // 面孔走半透明白；其余 floating（glass 深色主题、iOS 无模糊端）一律走
  // surfaceRaised 亮度台阶；iOS BlurView 端保持透明（实填由其内的
  // BlurView + glass 叠层提供）。
  const discFill =
    tone === 'step'
      ? theme.colors.canvasDrawer
      : floating
        ? Platform.OS === 'android' && !theme.dark && tone === 'glass'
          ? androidGlassFill
          : iosBlur
            ? 'transparent'
            : theme.colors.surfaceRaised
        : theme.colors.surfaceRaised;

  // 软阴影只挂 Android（深色短路在 SoftShadow 内部按主题裁决）；
  // step 台阶盘无影（A2 定案），在 tone 级抑制
  const showSoftShadow =
    floating && tone !== 'step' && Platform.OS === 'android';

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={
        showBadge
          ? `${accessibilityLabel}，${badge} 条未读`
          : accessibilityLabel
      }
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={hitSlop}
      onPress={onPress}
      onPressIn={() => {
        pressProgress.value = withTiming(1, {
          duration: theme.motion.duration.snappy,
        });
      }}
      onPressOut={() => {
        pressProgress.value = withTiming(0, {
          duration: theme.motion.duration.snappy,
        });
      }}
      style={[
        styles.button,
        {
          width: diameter,
          height: diameter,
          opacity: disabled ? 0.4 : 1,
        },
        style,
      ]}
    >
      {floating ? (
        <>
          {/* Android 浅色：SVG 软阴影（全 App 唯一阴影路径），置于最底层，
              向四周溢出 PAD 出血区显示扩散光晕；深色由 SoftShadow 内部短路 */}
          {showSoftShadow ? (
            <SoftShadow
              width={diameter}
              height={diameter}
              borderRadius={discRadius}
            />
          ) : null}
          {/* 填充节点：独立底层单一承载圆盘填充；iOS 的玻璃填充由其内的 BlurView 提供 */}
          <View
            pointerEvents="none"
            style={[
              styles.disc,
              {
                width: diameter,
                height: diameter,
                borderRadius: discRadius,
                backgroundColor: discFill,
              },
            ]}
          >
            {iosBlur ? (
              <BlurView
                pointerEvents="none"
                intensity={40}
                tint={theme.dark ? 'dark' : 'light'}
                style={[
                  styles.blurFill,
                  {
                    borderRadius: discRadius,
                    backgroundColor: theme.colors.glass,
                  },
                ]}
              />
            ) : null}
          </View>
        </>
      ) : null}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.disc,
          {
            width: diameter,
            height: diameter,
            borderRadius: discRadius,
            backgroundColor: pressedFill,
          },
          pressOverlayStyle,
        ]}
      />
      <Icon name={name} size={size} color={color ?? theme.colors.textPrimary} />
      {showBadge ? (
        <View
          style={[
            styles.badge,
            {
              top: theme.space.xxs,
              right: theme.space.xxs,
              minWidth: theme.size.badge,
              height: theme.size.badge,
              borderRadius: theme.radius.pill,
              paddingHorizontal: theme.space.xs,
              backgroundColor: theme.colors.danger,
            },
          ]}
        >
          <AppText
            variant="caption"
            color="dangerForeground"
            style={styles.badgeText}
          >
            {badge > badgeCap ? `${badgeCap}+` : String(badge)}
          </AppText>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  // 圆盘各层（填充节点 / 按压叠层）共用：绝对铺满宿主钮面
  disc: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  blurFill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    overflow: 'hidden',
  },
  badge: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    fontWeight: '600',
  },
});

export default IconButton;
