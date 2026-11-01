import { useCallback } from 'react';
import { router } from 'expo-router';
import HomeScreen from '@/presentation/screens/homeScreen';
import { useOpenDrawer } from '@/presentation/navigation/useOpenDrawer';

export default function HomeRoute() {
  const openDrawer = useOpenDrawer();
  // 新会话创建后替换当前页，返回键不会回到已提交的空态
  const openSession = useCallback((sessionId: string) => {
    router.replace(`/session/${sessionId}`);
  }, []);
  return (
    <HomeScreen
      onOpenDrawer={openDrawer}
      onOpenNotifications={() => router.push('/notifications')}
      onOpenSession={openSession}
    />
  );
}
