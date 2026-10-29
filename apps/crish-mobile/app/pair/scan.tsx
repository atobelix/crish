import { router } from 'expo-router';
import PairScanScreen from '@/presentation/pair/pairScanScreen';
import { useSafeBack } from '../_components/useSafeBack';

export default function PairScanRoute() {
  const goBack = useSafeBack();
  return (
    <PairScanScreen onClose={goBack} onPaired={() => router.replace('/')} />
  );
}
