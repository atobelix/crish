import { router } from 'expo-router';
import PairWelcomeScreen from '@/presentation/pair/pairWelcomeScreen';

export default function PairWelcomeRoute() {
  return (
    <PairWelcomeScreen
      onLogin={() => router.push('/account/login')}
      onOpenManual={() => router.push('/pair/manual')}
      onOpenScan={() => router.push('/pair/scan')}
      onEnterApp={() => router.replace('/')}
    />
  );
}
