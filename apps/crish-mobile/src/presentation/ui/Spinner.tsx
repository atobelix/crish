// 加载指示器：统一颜色与尺寸。
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';

export interface SpinnerProps {
  size?: 'small' | 'large';
  /** 是否占满可用空间并居中 */
  centered?: boolean;
}

export function Spinner({ size = 'small', centered = false }: SpinnerProps) {
  const theme = useTheme();
  const indicator = (
    <ActivityIndicator size={size} color={theme.colors.textTertiary} />
  );
  if (!centered) return indicator;
  return <View style={styles.center}>{indicator}</View>;
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default Spinner;
