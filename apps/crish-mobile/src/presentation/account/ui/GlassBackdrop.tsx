// 磨砂玻璃底层：铺满父容器（父容器负责圆角与 overflow: hidden）。
// iOS 用 expo-blur BlurView（intensity 40，深色模式 tint dark）叠 glass / glassSheet 半透明色；
// Android 的 BlurView 需 BlurTargetView 包裹整页才能真模糊，否则只渲染半透明色，
// 观感不稳定，因此 Android 与「降低透明度」开启时一律走实色兜底（v3 稿：浅色 field / 深色 gray.2 = fillSubtle）。
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { useTheme } from '@/adapters/platform/theme';

/** v3 稿：玻璃模糊强度 */
export const GLASS_BLUR_INTENSITY = 40;

/** 当前平台是否走真模糊（仅 iOS） */
export const GLASS_BLUR_SUPPORTED = Platform.OS === 'ios';

type GlassTone = 'glass' | 'glassSheet';

export interface GlassBackdropProps {
  tone: GlassTone;
}

/** 订阅系统「降低透明度」开关；原生模块缺失（jest 等）时视为关闭 */
export function useReduceTransparency(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceTransparencyEnabled()
      .then((value) => {
        if (mounted) setEnabled(value);
      })
      .catch(() => {
        /* swallow-ok: 原生模块缺失时保持 false */
      });
    const subscription = AccessibilityInfo.addEventListener(
      'reduceTransparencyChanged',
      (value: boolean) => {
        if (mounted) setEnabled(value);
      }
    );
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
  return enabled;
}

export function GlassBackdrop({ tone }: GlassBackdropProps) {
  const theme = useTheme();
  const reduceTransparency = useReduceTransparency();
  if (!GLASS_BLUR_SUPPORTED || reduceTransparency) {
    return (
      <View
        pointerEvents="none"
        testID="glass-solid"
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: theme.dark
              ? theme.colors.fillSubtle
              : theme.colors.field,
          },
        ]}
      />
    );
  }
  return (
    <BlurView
      pointerEvents="none"
      testID="glass-blur"
      intensity={GLASS_BLUR_INTENSITY}
      tint={theme.dark ? 'dark' : 'light'}
      style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors[tone] }]}
    />
  );
}

export default GlassBackdrop;
