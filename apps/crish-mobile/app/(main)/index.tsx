import { useCallback } from 'react';
import { router } from 'expo-router';
import HomeScreen from '@/presentation/screens/homeScreen';
import { useOpenDrawer } from '@/presentation/navigation/useOpenDrawer';

export default function HomeRoute() {
  const openDrawer = useOpenDrawer();
  // 会话/线程打开统一 navigate 压栈（2026-11-05 导航语义矩阵）：
  // (main) 组已改为显式 Stack 且动态屏配 getId——同 id 复用置顶（去重）、
  // 异 id 真压栈，返回即回到上一个打开的界面；主页本身是新对话落点，
  // 返回主页回到新对话面属正当目标，旧"replace 不回空态"口径废止。
  const openSession = useCallback((sessionId: string) => {
    router.navigate(`/session/${sessionId}`);
  }, []);
  // 本地线程同款 navigate 进壳内 /thread（界面统一 U3）：与远端会话同一
  // (main) 栈语义换内容，无根栈压栈跳屏
  const openLocalThread = useCallback((threadId: string) => {
    router.navigate(`/thread/${threadId}`);
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
