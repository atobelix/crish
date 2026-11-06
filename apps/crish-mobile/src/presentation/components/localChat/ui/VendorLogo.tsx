// 官方 AI 供应商纯矢量徽标组件
// 纯矢量呈现，根据主题与背景色动态挂载暗色发丝微边框，确保在深黑背景中边缘清晰可见。
import type { FC } from 'react';
import { StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '@/adapters/platform/theme';
import type { LocalVendorKey } from '@/domain/types/localChat';
import { getVendorLogoMeta, type VendorLogoMeta } from './vendorLogosData';

export interface VendorLogoProps {
  /** 厂商标识符（不区分大小写，回退至 custom） */
  vendor?: LocalVendorKey;
  /** 外盒尺寸（dp），默认 36 */
  size?: number;
  /** 圆角半径（dp），默认 9 */
  borderRadius?: number;
  /** 自定义外容器样式 */
  style?: StyleProp<ViewStyle>;
  /** 无障碍标签 */
  accessibilityLabel?: string;
}

const DEFAULT_SIZE = 36;
const DEFAULT_RADIUS = 9;

export const VendorLogo: FC<VendorLogoProps> = ({
  vendor,
  size = DEFAULT_SIZE,
  borderRadius = DEFAULT_RADIUS,
  style,
  accessibilityLabel,
}) => {
  const theme = useTheme();
  const meta: VendorLogoMeta = getVendorLogoMeta(vendor);

  // 内嵌矢量渲染尺寸，约 58%（默认 36dp 对应 21dp，34dp 对应 20dp）
  const iconSize = Math.round(size * 0.58);

  // 暗色主题下深黑系徽标（openai, ollama, custom）自动附加微妙发丝边框
  const withDarkHairline = theme.dark && meta.isDarkBg;

  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel ?? `${meta.label} logo`}
      style={[
        styles.box,
        {
          width: size,
          height: size,
          borderRadius,
          backgroundColor: meta.bg,
        },
        withDarkHairline && styles.darkHairline,
        style,
      ]}
    >
      <Svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 24 24"
        fill="none"
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        <Path
          d={meta.d}
          fill={meta.mode === 'fill' ? meta.color : 'none'}
          stroke={meta.mode === 'stroke' ? meta.color : undefined}
          strokeWidth={meta.strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    </View>
  );
};

export default VendorLogo;

const styles = StyleSheet.create({
  box: {
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    overflow: 'hidden',
  },
  darkHairline: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
});
