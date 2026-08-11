import { useLocalSearchParams } from 'expo-router';
import ProtectedPlaceholder from '@/presentation/components/templates/ProtectedPlaceholder';

// 会话详情（F3 主形态：消息流 / 事件流双视图）—— R2-05 落地
export default function SessionDetailScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  return (
    <ProtectedPlaceholder
      title="会话详情"
      description={`消息流 / 事件流 feed（R2-05 落地）\nsessionId: ${sessionId ?? '-'}`}
    />
  );
}
