import { Redirect } from 'expo-router';
import { useAuthStore } from '@/adapters/hooks/useAppStore';
import PlaceholderScreen, {
  type PlaceholderScreenProps,
} from './PlaceholderScreen';

// 受保护占位页：深链详情页（session/approval/run/terminal）统一守卫——
// 未配对 → 强制配对页（D4 §8.6：冷启动深链未配对跳配对页，pendingRoute 由 R3-04 补跳）
export default function ProtectedPlaceholder({
  title,
  description,
}: PlaceholderScreenProps) {
  const pairState = useAuthStore((s) => s.pairState);

  if (pairState !== 'paired') {
    return <Redirect href="/pair/welcome" />;
  }

  return <PlaceholderScreen title={title} description={description} />;
}
