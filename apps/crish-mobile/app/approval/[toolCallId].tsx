import { useLocalSearchParams } from 'expo-router';
import ProtectedPlaceholder from '@/presentation/components/templates/ProtectedPlaceholder';

// 审批详情（F2 §5.1 / 推送深链目标：crish://approval/<toolCallId>）—— R2-04 落地
export default function ApprovalDetailScreen() {
  const { toolCallId } = useLocalSearchParams<{ toolCallId: string }>();
  return (
    <ProtectedPlaceholder
      title="审批详情"
      description={`审批卡 / 双阶段确认 / 离线 outbox（R2-04 落地）\ntoolCallId: ${toolCallId ?? '-'}`}
    />
  );
}
