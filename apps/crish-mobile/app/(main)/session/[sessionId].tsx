// 会话页路由：配对守卫由 (main)/_layout.tsx 统一负责；汉堡打开抽屉，工具调用以 formSheet 打开。
import { router, useLocalSearchParams } from 'expo-router';
import SessionDetailScreen from '@/presentation/screens/sessionDetailScreen';
import { useOpenDrawer } from '@/presentation/navigation/useOpenDrawer';

export default function SessionDetailRoute() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const id = sessionId ?? '';
  const openDrawer = useOpenDrawer();
  return (
    <SessionDetailScreen
      sessionId={id}
      onOpenDrawer={openDrawer}
      onOpenRun={(runId) => router.push(`/run/${runId}`)}
      onOpenTerminal={(runId) => router.push(`/terminal/${runId}`)}
      onOpenTools={(focusId) =>
        router.push(
          focusId
            ? {
                pathname: '/tools/[sessionId]',
                params: { sessionId: id, focus: focusId },
              }
            : { pathname: '/tools/[sessionId]', params: { sessionId: id } }
        )
      }
    />
  );
}
