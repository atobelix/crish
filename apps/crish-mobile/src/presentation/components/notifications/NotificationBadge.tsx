// 通知未读角标（R2-04 部分 5：首页铃铛入口角标，与通知中心「全部已读」区共用形态）
// - 仅 count > 0 渲染（角标诚实化：未读为 0 不显示 0，M4 §4.1）；
// - 99+ 收敛（F1 §4.8 合并角标 ≤99+，notificationBadgeLabel）。
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { notificationBadgeLabel } from './notificationMeta';

export interface NotificationBadgeProps {
  /** 未读计数（≤0 不渲染） */
  count: number;
  /** 测试锚点（缺省 notification-badge） */
  testID?: string;
}

/** 未读数字角标（红底白字，对齐 SessionRow 未读角标形态） */
export function NotificationBadge({
  count,
  testID = 'notification-badge',
}: NotificationBadgeProps) {
  const theme = useTheme();
  if (count <= 0) return null;
  return (
    <View
      testID={testID}
      style={[styles.badge, { backgroundColor: theme.colorError }]}
      accessible
      accessibilityLabel={`${count} 条未读通知`}
    >
      <Text style={[styles.text, { color: theme.textOnDanger }]}>
        {notificationBadgeLabel(count)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    fontSize: 11,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
});
