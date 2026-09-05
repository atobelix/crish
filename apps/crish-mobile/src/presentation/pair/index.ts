// 配对流程表现层（R2-03 部分 3：pair* 命名组件 + 接线装配引导）
export { default as PairWelcomeScreen } from './pairWelcomeScreen';
export type { PairWelcomeScreenProps } from './pairWelcomeScreen';
export { default as PairManualScreen } from './pairManualScreen';
export type { PairManualScreenProps } from './pairManualScreen';
export {
  ensurePairingController,
  ensurePairingWiringForApp,
  configurePairingDriver,
} from './pairingBootstrap';
export type { PairingController } from './pairingBootstrap';
