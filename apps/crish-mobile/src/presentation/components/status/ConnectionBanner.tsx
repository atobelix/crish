// 连接状态横幅（原型 main-notice-banner）：胶囊动作型卡片——左状态文案、右「切换」
// 胶囊为主动作（唤起设备切换）。帮助 / 重试是参考原型没有的排障功能件（N02 DEF-14），
// 收敛为不抢眼的次级小入口（帮助 = 弱文字链、重试 = 小号弱色图标钮）排在胶囊左侧。
// 仅在非 ready 时出现；断连排障入口保留 ConnectionHelpSheet。
import { useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import {
  AppText,
  Icon,
  IconButton,
  SoftShadowSurface,
} from '@/presentation/ui';
import {
  AnimatedPressable,
  usePressFade,
} from '@/presentation/ui/pressFeedback';
import { ConnectionHelpSheet } from '@/presentation/components/status/ConnectionHelpSheet';

export interface ConnectionBannerProps {
  phaseLabel: string;
  lastError?: string | null;
  onRetry: () => void;
  /** 「切换」胶囊动作：唤起设备切换（未传时回退为重试） */
  onSwitch?: () => void;
}

export function ConnectionBanner({
  phaseLabel,
  lastError,
  onRetry,
  onSwitch,
}: ConnectionBannerProps) {
  const theme = useTheme();
  const [helpOpen, setHelpOpen] = useState(false);
  const switchPress = usePressFade();
  const helpPress = usePressFade();
  return (
    <Animated.View
      testID="connection-banner"
      // 出现/消失淡入淡出（有状态切换必有动画）：原型 main-notice-banner
      // transition 0.22s（theme.motion.duration.sheet 档，批 A 字面量收编）
      entering={FadeIn.duration(theme.motion.duration.sheet)}
      exiting={FadeOut.duration(theme.motion.duration.sheet)}
      style={[
        styles.banner,
        {
          // 原型：margin 10/16/2（圆角/填充/内衬归 SoftShadowSurface 内层）
          marginHorizontal: theme.space.lg,
          marginTop: theme.space.sm + 2,
          marginBottom: theme.space.xxs,
        },
      ]}
    >
      {/* 横幅软阴影（2026-11-02 用户裁定：所有阴影都是软阴影，原「阴影不采」
          豁免作废）：banner 档 = 按钮档 α 两层 + 放大半径（阴影上限裁决
          2026-11-02 晚：横幅改按钮那档、半径放大），仅 Android 浅色渲染 */}
      <SoftShadowSurface
        preset="banner"
        borderRadius={theme.radius.menu}
        fill={theme.colors.surface}
        style={styles.surface}
        fillStyle={{
          borderRadius: theme.radius.menu,
          paddingVertical: theme.space.sm + 2,
          paddingLeft: theme.space.lg,
          paddingRight: theme.space.md + 2,
          gap: theme.space.sm,
          flexDirection: 'row',
          alignItems: 'center',
        }}
      >
        <Icon
          name="alert-circle"
          size={theme.size.iconSmall}
          color={theme.colors.textSecondary}
        />
        {/* 原型文案 12.5/500、次级文字色 */}
        <AppText
          variant="caption"
          color="textSecondary"
          style={styles.bannerText}
          numberOfLines={1}
        >
          {lastError ?? phaseLabel}
        </AppText>
        {/* 原型次级排障入口（帮助）：弱文字链，按压整件透明度 120ms 过渡 */}
        <AnimatedPressable
          accessibilityRole="button"
          accessibilityLabel="查看连接帮助"
          testID="connection-help-entry"
          onPress={() => setHelpOpen(true)}
          onPressIn={helpPress.onPressIn}
          onPressOut={helpPress.onPressOut}
          hitSlop={theme.space.sm}
          style={helpPress.fadeStyle}
        >
          <AppText variant="caption" color="textTertiary">
            帮助
          </AppText>
        </AnimatedPressable>
        <IconButton
          name="refresh"
          accessibilityLabel="重新连接"
          onPress={onRetry}
          size={theme.size.iconSmall}
          color={theme.colors.textTertiary}
        />
        {/* 原型主动作「切换」胶囊：高 28、底 fillSubtle、字 12/550（取 sectionLabel 12/600 近似） */}
        <Pressable
          testID="connection-switch"
          accessibilityRole="button"
          accessibilityLabel="切换设备"
          onPress={onSwitch ?? onRetry}
          onPressIn={switchPress.onPressIn}
          onPressOut={switchPress.onPressOut}
          style={[
            styles.switchCapsule,
            {
              height: theme.size.barAction - 6,
              paddingHorizontal: theme.space.md,
              borderRadius: theme.radius.pill,
              backgroundColor: theme.colors.fillSubtle,
            },
          ]}
        >
          <Animated.View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              {
                borderRadius: theme.radius.pill,
                backgroundColor: theme.colors.fillPressed,
              },
              switchPress.overlayStyle,
            ]}
          />
          <AppText variant="sectionLabel">切换</AppText>
        </Pressable>
        <ConnectionHelpSheet
          visible={helpOpen}
          onClose={() => setHelpOpen(false)}
        />
      </SoftShadowSurface>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: { width: '100%', flexDirection: 'row', alignItems: 'center' },
  surface: { flex: 1, width: '100%' },
  bannerText: { flex: 1, fontWeight: '500' },
  switchCapsule: { alignItems: 'center', justifyContent: 'center' },
});

export default ConnectionBanner;
