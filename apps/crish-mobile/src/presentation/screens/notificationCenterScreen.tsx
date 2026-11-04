// 通知中心：未读管理 + 深链跳转。
// 时间分组（批 C ⑬）：列表按本地日历日分 今天/昨天/更早 三组呈现
// （分组投影在 VM 的 sections，纯函数 groupNotificationsByDay）。
import { SectionList, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { useNotificationCenterVm } from '@/adapters/viewmodels/useNotificationCenterVm';
import type { InAppNotification } from '@/domain/store/notificationReducers';
import {
  AppHeader,
  AppText,
  EmptyState,
  Screen,
  useToast,
} from '@/presentation/ui';
import {
  AnimatedPressable,
  usePressFade,
} from '@/presentation/ui/pressFeedback';
import { NotificationRow } from '@/presentation/components/notifications/NotificationRow';
import { notificationRouteToPath } from '@/notifications/notificationMeta';

export interface NotificationCenterScreenProps {
  onBack: () => void;
  onOpenNotification: (path: string) => void;
}

export default function NotificationCenterScreen({
  onBack,
  onOpenNotification,
}: NotificationCenterScreenProps) {
  const theme = useTheme();
  const toast = useToast();
  const vm = useNotificationCenterVm();
  const markAllPress = usePressFade();

  const handlePress = (item: InAppNotification) => {
    vm.markRead(item.id);
    const path = notificationRouteToPath(item);
    if (path !== null) onOpenNotification(path);
  };

  return (
    <Screen>
      <AppHeader
        title="通知"
        onBack={onBack}
        actions={
          vm.unreadCount > 0 ? (
            <AnimatedPressable
              testID="mark-all-read"
              accessibilityRole="button"
              accessibilityLabel="全部已读"
              onPress={() => {
                vm.markAllRead();
                toast.showToast('已全部标为已读', 'success');
              }}
              onPressIn={markAllPress.onPressIn}
              onPressOut={markAllPress.onPressOut}
              style={[styles.action, markAllPress.fadeStyle]}
            >
              <AppText variant="footnote" color="textPrimary">
                全部已读
              </AppText>
            </AnimatedPressable>
          ) : undefined
        }
      />
      {vm.items.length === 0 ? (
        <EmptyState title="暂无通知" />
      ) : (
        <SectionList
          testID="notification-list"
          sections={vm.sections.map((section) => ({
            key: section.key,
            title: section.title,
            data: [...section.items],
          }))}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <NotificationRow item={item} onPress={handlePress} />
          )}
          renderSectionHeader={({ section }) => (
            <View
              style={[
                styles.sectionHeader,
                {
                  paddingHorizontal: theme.space.lg,
                  paddingTop: theme.space.md,
                  paddingBottom: theme.space.xs,
                },
              ]}
            >
              <AppText variant="caption" color="textTertiary">
                {section.title}
              </AppText>
            </View>
          )}
          contentContainerStyle={[
            styles.content,
            { paddingBottom: theme.space.xxl },
          ]}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  action: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  content: {
    paddingTop: 4,
  },
  sectionHeader: {},
});
