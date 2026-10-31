// 通知行：类别标签 / 标题 / 正文 + 时间 + 未读点。
// N05 裁定：前置彩色圆盘图标删除（标题摘要明确 + 未读红点已足够），列表平整。
import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { formatRelativeTime } from '@/domain/pure/time';
import type { InAppNotification } from '@/domain/store/notificationReducers';
import { AppText, Badge } from '@/presentation/ui';
import {
  NOTIFICATION_CATEGORY_LABEL,
  notificationKindCategory,
} from '@/notifications/notificationMeta';

export interface NotificationRowProps {
  item: InAppNotification;
  onPress: (item: InAppNotification) => void;
  divider?: boolean;
}

export const NotificationRow = memo(function NotificationRow({
  item,
  onPress,
  divider = false,
}: NotificationRowProps) {
  const theme = useTheme();
  const category = notificationKindCategory(item.kind);
  const unread = item.status === 'shown';
  const categoryColor =
    category === 'approval'
      ? theme.colors.warning
      : category === 'system'
        ? theme.colors.danger
        : theme.colors.info;

  return (
    <Pressable
      testID={`notification-row-${item.id}`}
      accessibilityRole="button"
      accessibilityLabel={`${NOTIFICATION_CATEGORY_LABEL[category]}：${item.title}${unread ? '，未读' : ''}`}
      onPress={() => onPress(item)}
      style={({ pressed }) => [
        styles.row,
        {
          borderBottomColor: theme.colors.hairline,
          borderBottomWidth: divider ? StyleSheet.hairlineWidth : 0,
        },
        pressed && { backgroundColor: theme.colors.fillPressed },
      ]}
    >
      <View style={styles.body}>
        <View style={styles.titleRow}>
          <AppText variant="caption" style={{ color: categoryColor }}>
            {NOTIFICATION_CATEGORY_LABEL[category]}
          </AppText>
          <AppText variant="bodyStrong" numberOfLines={1} style={styles.title}>
            {item.title}
          </AppText>
          <AppText variant="caption" color="textTertiary">
            {formatRelativeTime(item.receivedAt)}
          </AppText>
        </View>
        {item.body ? (
          <AppText variant="footnote" color="textSecondary" numberOfLines={2}>
            {item.body}
          </AppText>
        ) : null}
      </View>
      {unread ? <Badge dot tone="danger" /> : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: 68,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  body: {
    flex: 1,
    gap: 3,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    flex: 1,
  },
});

export default NotificationRow;
