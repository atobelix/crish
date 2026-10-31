// 通知中心：未读管理 + 深链跳转。
import { FlatList, Pressable, StyleSheet } from 'react-native';
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
            <Pressable
              testID="mark-all-read"
              accessibilityRole="button"
              accessibilityLabel="全部已读"
              onPress={() => {
                vm.markAllRead();
                toast.showToast('已全部标为已读', 'success');
              }}
              style={({ pressed }) => [
                styles.action,
                pressed && { opacity: 0.65 },
              ]}
            >
              <AppText variant="footnote" color="textPrimary">
                全部已读
              </AppText>
            </Pressable>
          ) : undefined
        }
      />
      {vm.items.length === 0 ? (
        <EmptyState title="暂无通知" />
      ) : (
        <FlatList
          testID="notification-list"
          data={[...vm.items]}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <NotificationRow item={item} onPress={handlePress} />
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
});
