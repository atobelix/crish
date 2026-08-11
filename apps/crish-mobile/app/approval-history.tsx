import ProtectedPlaceholder from '@/presentation/components/templates/ProtectedPlaceholder';

// 审批历史（F2 第 7 章）—— R2-04 落地
export default function ApprovalHistoryScreen() {
  return (
    <ProtectedPlaceholder
      title="审批历史"
      description="已决 / 过期 / 冲突条目（R2-04 落地）"
    />
  );
}
