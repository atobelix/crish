import { router, type Href } from 'expo-router';
import NotificationCenterScreen from '@/presentation/screens/notificationCenterScreen';
import { Protected } from '@/presentation/components/auth/Protected';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function NotificationsRoute() {
  const goBack = useSafeBack();
  return (
    <Protected>
      <NotificationCenterScreen
        onBack={goBack}
        onOpenNotification={(path) => router.push(path as Href)}
      />
    </Protected>
  );
}
