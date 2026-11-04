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
  // 本地线程同款 replace 进壳内 /thread（界面统一 U3）：与远端会话同一
  // (main) 槽位换内容，无根栈压栈跳屏——主页本地发送「就地呈现」的落点
  const openLocalThread = useCallback((threadId: string) => {
    router.replace(`/thread/${threadId}`);
  }, []);
  return (
    <HomeScreen
      onOpenDrawer={openDrawer}
      onOpenNotifications={() => router.push('/notifications')}
      onOpenSession={openSession}
      onOpenLocalThread={openLocalThread}
    />
  );
}
