// 通知中心行（R2-04 部分 5：应用内通知列表行，F1 §4.8 通知卡片形态本地实现）
// - 结构：类型徽章（审批/事件/系统，notificationKindCategory 三分映射 + 语义色）→
//   标题（1 行截断）+ 正文（最多 2 行，可空）+ 相对时间（formatRelativeTime，time.ts）；
// - 未读标记：status === 'shown' 时左侧 3px 警示条（colorError）+ 读屏「未读」文案
//   （R2UX §4.2-3 状态表达双通道：视觉条 + 读屏文字，不单靠颜色）；
// - 交互：行点击 → 父级编排（markRead + 深链跳转）；点击即已读语义（F2 §6.2 决策后撤销/已读）。
// - 纯展示组件：item/nowMs/onPress 注入，组件测试可直接挂载（不感知 store / 路由）。
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, type ThemeTokens } from '@/adapters/platform/theme';
import { formatRelativeTime } from '@/domain/pure/time';
import type { InAppNotification } from '@/domain/store/notificationReducers';
import {
  NOTIFICATION_CATEGORY_LABEL,
  notificationKindCategory,
  type NotificationKindCategory,
} from './notificationMeta';

/** 类型三分 → 徽章语义色（token 键，运行期取色：审批黄 / 事件中性 / 系统红，F1 §4.8） */
const CATEGORY_COLORS: Record<
  NotificationKindCategory,
  { bg: keyof ThemeTokens; fg: keyof ThemeTokens }
> = {
  approval: { bg: 'colorWarningBg', fg: 'colorWarning' },
  event: { bg: 'bgTertiary', fg: 'textSecondary' },
  system: { bg: 'colorErrorBg', fg: 'colorError' },
};

export interface NotificationRowProps {
  item: InAppNotification;
  /** 相对时间基准（缺省 Date.now；测试注入固定值） */
  nowMs?: number;
  /** 行点击（父级：markRead + 深链） */
  onPress: (item: InAppNotification) => void;
}

/** 通知中心行（memo：列表行级重渲染纪律，R2UX-05-01 行 memo 同款） */
export const NotificationRow = memo(function NotificationRow({
  item,
  nowMs = Date.now(),
  onPress,
}: NotificationRowProps) {
  const theme = useTheme();
  const category = notificationKindCategory(item.kind);
  const colors = CATEGORY_COLORS[category];
  const unread = item.status === 'shown';
  const relativeTime = formatRelativeTime(item.receivedAt, nowMs);

  // 读屏聚合文案（R2UX §4.1：类型 + 摘要 + 未读态合并为单一可读文本）
  const a11yParts = [
    `通知 ${NOTIFICATION_CATEGORY_LABEL[category]}`,
    item.title,
    relativeTime,
    unread ? '未读' : '已读',
  ].filter(Boolean);

  return (
    <Pressable
      testID={`notification-row-${item.id}`}
      accessibilityRole="button"
      accessibilityLabel={a11yParts.join('，')}
      onPress={() => onPress(item)}
      style={({ pressed }) => [
        styles.row,
        {
          borderBottomColor: theme.hairline,
          borderLeftColor: unread ? theme.colorError : 'transparent',
        },
        pressed && { backgroundColor: theme.bgTertiary },
      ]}
    >
      <View
        style={[styles.kindBadge, { backgroundColor: theme[colors.bg] }]}
        testID="notification-kind"
      >
        <Text style={[styles.kindText, { color: theme[colors.fg] }]}>
          {NOTIFICATION_CATEGORY_LABEL[category]}
        </Text>
      </View>
      <View style={styles.body}>
        <Text
          testID="notification-title"
          numberOfLines={1}
          style={[styles.title, { color: theme.textPrimary }]}
        >
          {item.title}
        </Text>
        {item.body !== null && item.body !== '' ? (
          <Text
            testID="notification-body"
            numberOfLines={2}
            style={[styles.bodyText, { color: theme.textSecondary }]}
          >
            {item.body}
          </Text>
        ) : null}
        <Text
          testID="notification-time"
          style={[styles.time, { color: theme.textTertiary }]}
        >
          {relativeTime}
        </Text>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 72,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: 3,
    borderLeftColor: 'transparent',
  },
  kindBadge: {
    minWidth: 44,
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  kindText: {
    fontSize: 12,
    fontWeight: '600',
  },
  body: {
    flex: 1,
    gap: 3,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
  },
  bodyText: {
    fontSize: 13,
    lineHeight: 18,
  },
  time: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
});
