import ProtectedPlaceholder from '@/presentation/components/templates/ProtectedPlaceholder';

// 诊断页（D4 §6.6：连接状态快照 / 网关握手 / 推送状态）—— R2-06 落地
export default function DiagnosticsScreen() {
  return (
    <ProtectedPlaceholder
      title="诊断"
      description="连接快照 / 网关信息 / 推送状态（R2-06 落地）"
    />
  );
}
