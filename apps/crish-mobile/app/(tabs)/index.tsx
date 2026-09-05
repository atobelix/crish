import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { useNotificationStore } from '@/adapters/hooks/useNotificationStore';
import { NotificationBadge } from '@/presentation/components/notifications/NotificationBadge';
import { QuickRunPanel } from '@/presentation/components/dashboard/QuickRunPanel';
import {
  DashboardSkeleton,
  dashboardShowSkeleton,
} from '@/presentation/components/dashboard/DashboardSkeleton';
import { useQuickRunVm } from '@/adapters/viewmodels/useQuickRunVm';
import { useDashboardVm } from '@/adapters/viewmodels/useDashboardVm';

// 首页仪表盘（F1）：连接状态卡 / 活跃 run / 待批概览 / 会话摘要 —— R2-05 落地
// 通知入口（R2-04 部分 5 裁决：方案 a 首页顶部铃铛入口 + 未读角标，不新增 Tab——tab 已 5 个）：
// 铃铛角标 = notificationStore.unreadCount（>0 显示，99+ 收敛，F1 §4.8 / notificationBadgeLabel）；
// hydrated 前置：水合完成前不显示角标（notificationStore 注记：回填完成前展示会误导用户）。
// 首页首帧骨架（R2UX-05-10）：数据未就绪（无会话/feed 且连接未稳定）→ 骨架三块
// 避免白屏；缓存优先（已水合数据立即可见不显示骨架）；数据到达原位替换不闪烁。
export default function DashboardScreen() {
  const theme = useTheme();
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const hydrated = useNotificationStore((s) => s.hydrated);
  const dashboardVm = useDashboardVm();
  const quickRunVm = useQuickRunVm();
  const showSkeleton = dashboardShowSkeleton(
    dashboardVm.phase,
    dashboardVm.sessionId,
    dashboardVm.entries.length
  );

  return (
    <View style={[styles.container, { backgroundColor: theme.bgPrimary }]}>
      <View style={[styles.header, { borderBottomColor: theme.hairline }]}>
        <Text style={[styles.headerTitle, { color: theme.textPrimary }]}>
          首页
        </Text>
        <Pressable
          testID="notification-entry"
          accessibilityRole="button"
          accessibilityLabel={
            hydrated && unreadCount > 0
              ? `通知，${unreadCount} 条未读`
              : '通知中心'
          }
          onPress={() => router.push('/notifications')}
          style={styles.entryButton}
        >
          <Text style={[styles.entryText, { color: theme.textPrimary }]}>
            通知
          </Text>
          {hydrated ? (
            <NotificationBadge
              count={unreadCount}
              testID="notification-entry-badge"
            />
          ) : null}
        </Pressable>
      </View>
      {showSkeleton ? (
        <DashboardSkeleton />
      ) : (
        <QuickRunPanel vm={quickRunVm} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  entryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
  },
  entryText: {
    fontSize: 14,
    fontWeight: '500',
  },
});
