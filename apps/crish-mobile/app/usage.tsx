import ProtectedPlaceholder from '@/presentation/components/templates/ProtectedPlaceholder';

// 用量与缓存页（F1 §4.5）—— R2-06 落地
export default function UsageScreen() {
  return (
    <ProtectedPlaceholder
      title="用量与缓存"
      description="token 用量 / 本地缓存统计（R2-06 落地）"
    />
  );
}
