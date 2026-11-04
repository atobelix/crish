import { router } from 'expo-router';
import PairScanScreen from '@/presentation/pair/pairScanScreen';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function PairScanRoute() {
  const goBack = useSafeBack();

  const handlePaired = () => {
    if (router.canDismiss()) {
      try {
        router.dismissAll();
      } catch {
        /* swallow-ok: 容错处理 */
      }
    }
    router.replace('/');
  };

  return <PairScanScreen onClose={goBack} onPaired={handlePaired} />;
}
