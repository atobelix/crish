// 会话页路由：配对守卫由 (main)/_layout.tsx 统一负责；返回由 useSafeBack 处理，
// 工具调用以 formSheet 打开。
import { router, useLocalSearchParams } from 'expo-router';
import SessionDetailScreen from '@/presentation/screens/sessionDetailScreen';

export default function SessionDetailRoute() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const id = sessionId ?? '';
  return (
    <SessionDetailScreen
      sessionId={id}
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
