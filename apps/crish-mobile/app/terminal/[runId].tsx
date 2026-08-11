import { useLocalSearchParams } from 'expo-router';
import ProtectedPlaceholder from '@/presentation/components/templates/ProtectedPlaceholder';

// 终端流回放（F3 第 4 章 / 只读，深链目标）—— R2-05 落地
export default function TerminalScreen() {
  const { runId } = useLocalSearchParams<{ runId: string }>();
  return (
    <ProtectedPlaceholder
      title="终端回放"
      description={`只读终端流 / 行缓冲 / ANSI 白名单（R2-05 落地）\nrunId: ${runId ?? '-'}`}
    />
  );
}
