import { router } from 'expo-router';
import PairManualScreen from '@/presentation/pair/pairManualScreen';

// 手动配对页（R2-03 部分 3）：输入主机 + 配对码 → pairingWiring.beginPairing；
// 返回放弃确认（A4 裁决）确认后 router.back()（回到配对引导）。
export default function PairManualRoute() {
  return <PairManualScreen onBack={() => router.back()} />;
}
