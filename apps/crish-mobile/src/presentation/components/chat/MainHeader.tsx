// 主界面头栏：左右两侧等宽，中间内容真正居中；无大标题、无发丝线。
// 左右安全区由外层 Screen 处理，这里只补顶部。
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';

export interface MainHeaderProps {
  leading: ReactNode;
  center?: ReactNode;
  trailing?: ReactNode;
}

export function MainHeader({ leading, center, trailing }: MainHeaderProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        paddingTop: insets.top,
        paddingHorizontal: theme.space.xs,
      }}
    >
      <View
        style={[
          styles.row,
          { minHeight: theme.size.header, gap: theme.space.xs },
        ]}
      >
        <View style={[styles.side, styles.start]}>{leading}</View>
        <View style={styles.center}>{center ?? null}</View>
        <View style={[styles.side, styles.end]}>{trailing ?? null}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  side: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  start: { justifyContent: 'flex-start' },
  end: { justifyContent: 'flex-end' },
  // 中间内容按需收缩，过长时省略而不挤压两侧按钮
  center: { flexShrink: 1, alignItems: 'center' },
});
