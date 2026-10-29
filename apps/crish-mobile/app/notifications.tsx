import { router, type Href } from 'expo-router';
import NotificationCenterScreen from '@/presentation/screens/notificationCenterScreen';
import { Protected } from './_components/Protected';
import { useSafeBack } from './_components/useSafeBack';

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
