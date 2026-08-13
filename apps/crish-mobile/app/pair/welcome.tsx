import { router } from 'expo-router';
import PairWelcomeScreen from '@/presentation/pair/pairWelcomeScreen';

// 配对首页（R2-03 部分 3 接线）：引导 + 手动/扫码入口 + 已配对态兜底
// - 手动输入 → /pair/manual；扫码配对 → /pair/scan（占位，P2）；
// - 已配对态（冷启动恢复水合后 authStore paired）→ 进入应用 → (tabs)。
export default function PairWelcomeRoute() {
  return (
    <PairWelcomeScreen
      onOpenManual={() => router.push('/pair/manual')}
      onOpenScan={() => router.push('/pair/scan')}
      onEnterApp={() => router.replace('/(tabs)')}
    />
  );
}
