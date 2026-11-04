// 设备胶囊（原型 device-pill-btn）：磨砂胶囊（J7）+ 电脑图标与状态微标二合一 + 名称 + 下箭头。
// 点击唤起连接设备 Sheet。阴影口径（SVG 软阴影收编定案）：本胶囊是原型点名
// 的悬浮面之一——Android 浅色经 SoftShadow 出原型两层极淡投影（实测宽度
// 到手才渲染，口径同抽屉搜索胶囊），填充由本组件 backgroundColor 单一承担
// （surfaceRaised）；深色 SoftShadow 内部短路、区分回归亮度台阶；iOS 无
// 阴影，走 BlurView + glass 磨砂。
import { useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { useTheme } from '@/adapters/platform/theme';
import {
  useDeviceStatusVm,
  deviceLineOf,
} from '@/adapters/viewmodels/useDeviceStatusVm';
import { AppText, Icon, SoftShadow } from '@/presentation/ui';
import {
  AnimatedPressable,
  usePressFade,
} from '@/presentation/ui/pressFeedback';

export interface DevicePillProps {
  onPress: () => void;
}

export function DevicePill({ onPress }: DevicePillProps) {
  const theme = useTheme();
  const device = useDeviceStatusVm();
  const label = deviceLineOf(device);
  const iosBlur = Platform.OS === 'ios';
  // Android 软阴影需要实测宽度（胶囊宽随设备名变化），onLayout 捕获后渲染
  const [pillWidth, setPillWidth] = useState(0);
  const pillHeight = theme.size.barAction + 2;
  const press = usePressFade();
  return (
    <AnimatedPressable
      testID="device-pill"
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy: !device.connected }}
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      onLayout={(e) => setPillWidth(e.nativeEvent.layout.width)}
      style={[
        styles.pill,
        {
          height: pillHeight,
          borderRadius: theme.radius.pill,
          backgroundColor: iosBlur ? 'transparent' : theme.colors.surfaceRaised,
          paddingHorizontal: theme.space.md,
          gap: theme.space.sm - 1,
        },
        press.fadeStyle,
      ]}
    >
      {/* Android SVG 软阴影（全 App 唯一阴影路径）：最先渲染（最底层），
          只画阴影不绘填充（填充由上方 backgroundColor 单一承担） */}
      {Platform.OS === 'android' && pillWidth > 0 ? (
        <SoftShadow
          width={pillWidth}
          height={pillHeight}
          borderRadius={pillHeight / 2}
        />
      ) : null}
      {iosBlur ? (
        <BlurView
          pointerEvents="none"
          intensity={40}
          tint={theme.dark ? 'dark' : 'light'}
          style={[
            styles.blurFill,
            {
              borderRadius: theme.radius.pill,
              backgroundColor: theme.colors.glass,
            },
          ]}
        />
      ) : null}
      {/* 电脑图标与在线状态微标一体化（不占独立图标位） */}
      <View style={styles.iconBadge}>
        <Icon
          name="monitor"
          size={theme.size.iconSmall - 1}
          color={theme.colors.textPrimary}
        />
        {/* 原型 pip：5.5px 彩点 + box-shadow 外扩 1.5px 白圈；RN 以白底外圈包裹等效，
            定位按彩点中心与无圈版（top −1 / right −2）对齐反推 */}
        <View
          style={[
            styles.pipRing,
            {
              top: -2.5,
              right: -3.5,
              borderRadius: theme.radius.pill,
              backgroundColor: theme.colors.surfaceRaised,
            },
          ]}
        >
          <View
            testID="device-pill-pip"
            style={{
              width: 5.5,
              height: 5.5,
              borderRadius: theme.radius.pill,
              backgroundColor: device.connected
                ? theme.colors.success
                : theme.colors.dotOffline,
            }}
          />
        </View>
      </View>
      <AppText
        variant="footnote"
        numberOfLines={1}
        style={[
          styles.name,
          // 原型设备名 13.5（自 footnote 派生）
          { fontSize: theme.type.footnote.fontSize + 0.5 },
        ]}
      >
        {device.currentDeviceName}
      </AppText>
      <Icon
        name="chevron-down"
        size={theme.size.iconSmall - 5}
        color={theme.colors.textSecondary}
      />
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  blurFill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    overflow: 'hidden',
  },
  iconBadge: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pipRing: {
    position: 'absolute',
    width: 8.5,
    height: 8.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // 原型设备名 13.5/600、letter-spacing −0.01em（≈−0.14）；字号在组件内派生注入
  name: {
    maxWidth: 140,
    fontWeight: '600',
    letterSpacing: -0.14,
  },
});

export default DevicePill;
