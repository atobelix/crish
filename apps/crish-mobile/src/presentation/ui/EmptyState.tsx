// 空态：一句标题 + 可选一个动作；不写开发说明。
// N05/G4 裁定：空态大图标全线清退，纯文本呈现（非必要不显示图标）。
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import AppText from './AppText';

export interface EmptyStateProps {
  title: string;
  action?: ReactNode;
  testID?: string;
  compact?: boolean;
}

export function EmptyState({
  title,
  action,
  testID,
  compact = false,
}: EmptyStateProps) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={[
        styles.container,
        {
          paddingVertical: compact ? theme.space.section : 64,
          gap: theme.space.md,
        },
      ]}
    >
      <AppText variant="body" color="textSecondary" style={styles.title}>
        {title}
      </AppText>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  title: {
    textAlign: 'center',
  },
});

export default EmptyState;
