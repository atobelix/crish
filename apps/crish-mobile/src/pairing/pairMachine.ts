// 配对状态机（D4 §5.1 / Z0 R2-03 接口占位）：纯逻辑 reducer，可单测
// 状态：idle → scanning → requesting → exchanged → done；requesting → error（可重试）
// 事件与转换表严格按 D4 §5.1 登记；scanning 为扫码 UI 态（P2），转换表未登记其出边
export type PairState =
  'idle' | 'scanning' | 'requesting' | 'exchanged' | 'done' | 'error';

export type PairEvent =
  | { type: 'PIN_ENTERED' }
  | { type: 'SCAN_RECEIVED' }
  | { type: 'EXCHANGE_OK' }
  | { type: 'EXCHANGE_FAIL'; reason: string }
  | { type: 'RETRY' }
  | { type: 'TOKEN_STORED' };

export interface PairMachineResult {
  state: PairState;
  /** EXCHANGE_FAIL 携带的可读原因（错误码翻译由 R2-03 接 shared-types errors 面） */
  error: string | null;
  /** 是否发生状态迁移（非法事件 → false，调用方可忽略） */
  changed: boolean;
}

export const PAIR_INITIAL_STATE: PairState = 'idle';

// D4 §5.1 状态转换表：
//   idle      --PIN_ENTERED|SCAN_RECEIVED--> requesting
//   requesting --EXCHANGE_OK--> exchanged
//   requesting --EXCHANGE_FAIL--> error
//   error      --RETRY--> requesting
//   exchanged  --TOKEN_STORED--> done
export function reducePairState(
  state: PairState,
  event: PairEvent
): PairMachineResult {
  switch (event.type) {
    case 'PIN_ENTERED':
    case 'SCAN_RECEIVED':
      if (state === 'idle') {
        return { state: 'requesting', error: null, changed: true };
      }
      break;
    case 'EXCHANGE_OK':
      if (state === 'requesting') {
        return { state: 'exchanged', error: null, changed: true };
      }
      break;
    case 'EXCHANGE_FAIL':
      if (state === 'requesting') {
        return { state: 'error', error: event.reason, changed: true };
      }
      break;
    case 'RETRY':
      if (state === 'error') {
        return { state: 'requesting', error: null, changed: true };
      }
      break;
    case 'TOKEN_STORED':
      if (state === 'exchanged') {
        return { state: 'done', error: null, changed: true };
      }
      break;
  }
  return { state, error: null, changed: false };
}
