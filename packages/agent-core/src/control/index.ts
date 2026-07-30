/**
 * Run 控制平面（B0）
 *
 * 协议类型真源：@crish/shared-types；运行时队列：ControlBus。
 */

export type {
  RunControlLevel,
  RunControlLevelCode,
  RunControlWireLevel,
  RunControlKind,
  RunControlIntent,
  RunControlIntentInput,
  ProtocolRunControlIntent,
} from './types';
export {
  levelForKind,
  wireLevelForKind,
  isL1InjectKind,
  injectRingForKind,
  toProtocolRunControlIntent,
  RUN_CONTROL_LEVEL,
  RUN_CONTROL_LEVELS,
  isRunControlWireLevel,
  runControlLevelCode,
  isTerminatingRunControl,
  isForceCancelRunControl,
  createProtocolRunControlIntent,
} from './types';

export { ControlBus, type ControlDrainAction } from './control-bus';
