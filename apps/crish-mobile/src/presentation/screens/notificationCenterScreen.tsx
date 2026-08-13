// 通知中心页（R2-04 部分 5：应用内通知列表 + 未读管理）
// - 结构（F2 §6 通知语义 / R2UX §2.5 状态机）：头部（返回 + 「通知中心」 + 「全部已读」，
//   有未读时显示）→ 列表（NotificationRow，store receivedAt 降序透传，页面不重排）→
//   空态「暂无通知」；水合完成前加载态（notificationStore 注记：避免误导角标/列表）；
// - 深链：行点击 → markRead（点击即已读，M5 语义）→ notificationRouteToPath 白名单翻译
//   （D7 §7.4 / M4 §4.3）→ onOpenNotification 注入跳转；无目标路径则不跳（仅已读）；
// - 路由注入 onBack / onOpenNotification（页面不依赖 expo-router，组件测试可直接挂载）。
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { useNotificationCenterVm } from '@/adapters/viewmodels/useNotificationCenterVm';
import type { InAppNotification } from '@/domain/store/notificationReducers';
import { NotificationRow } from '@/presentation/components/notifications/NotificationRow';
import { notificationRouteToPath } from '@/presentation/components/notifications/notificationMeta';

export interface NotificationCenterScreenProps {
  /** 返回动作（路由注入 router.back；测试可注入 spy） */
  onBack?: () => void;
  /** 通知深链跳转（路由注入 router.push；notificationRouteToPath 已白名单翻译） */
  onOpenNotification: (path: string) => void;
}

export default function NotificationCenterScreen({
  onBack,
  onOpenNotification,
}: NotificationCenterScreenProps) {
  const theme = useTheme();
  const { items, unreadCount, hydrated, markRead, markAllRead } =
    useNotificationCenterVm();

  // 行点击：先已读（点击即已读语义），再按深链跳转（无目标路径仅已读，留在列表）
  const handlePress = (item: InAppNotification) => {
    markRead(item.id);
    const path = notificationRouteToPath(item);
    if (path !== null) onOpenNotification(path);
  };

  // 水合完成前不展示列表/空态（避免误导，notificationStore 注记）
  if (!hydrated) {
    return (
      <View
        style={[styles.container, styles.center]}
        testID="notification-loading"
      >
        <ActivityIndicator size="large" color={theme.colorInfo} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.bgPrimary }]}>
      {/* 头部（F2 §4.3 线框口径）：返回 + 标题 + 全部已读（有未读时显示） */}
      <View style={[styles.header, { borderBottomColor: theme.hairline }]}>
        <Pressable
          testID="header-back"
          accessibilityRole="button"
          accessibilityLabel="返回"
          onPress={onBack}
          style={styles.backButton}
        >
          <Text style={[styles.backText, { color: theme.textPrimary }]}>
            ← 返回
          </Text>
        </Pressable>
        <Text style={[styles.headerTitle, { color: theme.textPrimary }]}>
          通知中心
        </Text>
        {unreadCount > 0 ? (
          <Pressable
            testID="mark-all-read"
            accessibilityRole="button"
            accessibilityLabel="全部已读"
            onPress={markAllRead}
            style={styles.markAllButton}
          >
            <Text style={[styles.markAllText, { color: theme.colorInfo }]}>
              全部已读
            </Text>
          </Pressable>
        ) : (
          <View style={styles.markAllSpacer} />
        )}
      </View>

      {items.length === 0 ? (
        <View
          style={[styles.center, styles.emptyWrap]}
          testID="notification-empty"
        >
          <Text style={[styles.emptyTitle, { color: theme.textPrimary }]}>
            暂无通知
          </Text>
          <Text style={[styles.emptySub, { color: theme.textSecondary }]}>
            当桌面端 Agent 需要确认或运行结束时，通知会出现在这里
          </Text>
        </View>
      ) : (
        <FlatList
          testID="notification-list"
          style={styles.list}
          data={[...items]}
          keyExtractor={(n) => n.id}
          renderItem={({ item }) => (
            <NotificationRow item={item} onPress={handlePress} />
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
  },
  backButton: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  backText: {
    fontSize: 14,
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '600',
  },
  markAllButton: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  markAllText: {
    fontSize: 14,
    fontWeight: '500',
  },
  markAllSpacer: {
    minWidth: 60,
  },
  list: {
    flex: 1,
  },
  emptyWrap: {
    paddingVertical: 64,
    gap: 8,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  emptySub: {
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
});
