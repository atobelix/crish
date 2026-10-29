import { useCallback } from 'react';
import { router } from 'expo-router';
import NewChatScreen from '@/presentation/screens/newChatScreen';
import { useOpenDrawer } from '../_components/useOpenDrawer';

export default function NewChatRoute() {
  const openDrawer = useOpenDrawer();
  // 新会话创建后替换当前页，返回键不会回到已提交的空态
  const openSession = useCallback((sessionId: string) => {
    router.replace(`/session/${sessionId}`);
  }, []);
  return (
    <NewChatScreen
      onOpenDrawer={openDrawer}
      onOpenNotifications={() => router.push('/notifications')}
      onOpenSession={openSession}
    />
  );
}
