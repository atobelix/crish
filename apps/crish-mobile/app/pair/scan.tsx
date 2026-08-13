import { router } from 'expo-router';
import PairScanScreen from '@/presentation/pair/pairScanScreen';

// 扫码配对占位（P2 / G-10 注记：扫码功能即将推出，v1 手动输入先行）；
// 返回 → router.back()（回到配对引导）。
export default function PairScanRoute() {
  return <PairScanScreen onBack={() => router.back()} />;
}
