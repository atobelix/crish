import PairManualScreen from '@/presentation/pair/pairManualScreen';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function PairManualRoute() {
  const goBack = useSafeBack();
  return <PairManualScreen onBack={goBack} />;
}
