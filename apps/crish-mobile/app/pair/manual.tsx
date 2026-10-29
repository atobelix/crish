import PairManualScreen from '@/presentation/pair/pairManualScreen';
import { useSafeBack } from '../_components/useSafeBack';

export default function PairManualRoute() {
  const goBack = useSafeBack();
  return <PairManualScreen onBack={goBack} />;
}
