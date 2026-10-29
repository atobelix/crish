// 空态：图标 + 一句标题 + 可选一个动作；不写开发说明。
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import AppText from './AppText';
import Icon, { type IconName } from './Icon';

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  action?: ReactNode;
  testID?: string;
  compact?: boolean;
}

export function EmptyState({
  icon,
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
        { paddingVertical: compact ? theme.space.section : 64 },
      ]}
    >
      {icon ? (
        <Icon
          name={icon}
          size={theme.size.iconLarge}
          color={theme.colors.textDisabled}
        />
      ) : null}
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
    gap: 12,
  },
  title: {
    textAlign: 'center',
  },
});

export default EmptyState;
