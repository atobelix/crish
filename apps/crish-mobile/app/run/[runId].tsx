import { useLocalSearchParams } from 'expo-router';
import ProtectedPlaceholder from '@/presentation/components/templates/ProtectedPlaceholder';

// run 详情（F1 §4.3：状态条 + 事件时间线 + 用量卡）—— R2-05 落地
export default function RunDetailScreen() {
  const { runId } = useLocalSearchParams<{ runId: string }>();
  return (
    <ProtectedPlaceholder
      title="run 详情"
      description={`状态条 / 事件时间线 / 用量（R2-05 落地）\nrunId: ${runId ?? '-'}`}
    />
  );
}
