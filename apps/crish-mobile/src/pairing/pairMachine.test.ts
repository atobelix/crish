import { isCrishErrorCode } from '@crish/shared-types';
import {
  PAIR_INITIAL_STATE,
  reducePairState,
  type PairEvent,
  type PairState,
} from './pairMachine';

// 配对状态机单测（D4 §5.1 转换表全量 + 非法转换拒绝）
describe('pairMachine（D4 §5.1 转换表）', () => {
  it('初始状态为 idle', () => {
    expect(PAIR_INITIAL_STATE).toBe('idle');
  });

  it('正常主路径：idle → requesting → exchanged → done', () => {
    const s1 = reducePairState('idle', { type: 'PIN_ENTERED' });
    expect(s1).toEqual({ state: 'requesting', error: null, changed: true });

    const s2 = reducePairState(s1.state, { type: 'EXCHANGE_OK' });
    expect(s2.state).toBe('exchanged');

    const s3 = reducePairState(s2.state, { type: 'TOKEN_STORED' });
    expect(s3.state).toBe('done');
    expect(s3.changed).toBe(true);
  });

  it('SCAN_RECEIVED 与 PIN_ENTERED 同向：idle → requesting', () => {
    const r = reducePairState('idle', { type: 'SCAN_RECEIVED' });
    expect(r.state).toBe('requesting');
  });

  it('EXCHANGE_FAIL 进入 error 并记录原因，RETRY 可重试回 requesting', () => {
    const failed = reducePairState('requesting', {
      type: 'EXCHANGE_FAIL',
      reason: 'common.invalid_input',
    });
    expect(failed.state).toBe('error');
    expect(failed.error).toBe('common.invalid_input');
    // 失败原因走 shared-types 错误码面（验证 @crish/shared-types 链接 + 错误码权威面）
    expect(isCrishErrorCode(failed.error ?? '')).toBe(true);

    const retried = reducePairState(failed.state, { type: 'RETRY' });
    expect(retried.state).toBe('requesting');
    expect(retried.error).toBeNull();
  });

  it('非法转换拒绝并保留原状态（changed=false）', () => {
    const cases: Array<{ state: PairState; event: PairEvent }> = [
      { state: 'idle', event: { type: 'EXCHANGE_OK' } },
      { state: 'idle', event: { type: 'TOKEN_STORED' } },
      { state: 'requesting', event: { type: 'PIN_ENTERED' } },
      { state: 'requesting', event: { type: 'RETRY' } },
      { state: 'exchanged', event: { type: 'EXCHANGE_OK' } },
      { state: 'exchanged', event: { type: 'EXCHANGE_FAIL', reason: 'x' } },
      { state: 'done', event: { type: 'RETRY' } },
      { state: 'done', event: { type: 'TOKEN_STORED' } },
      { state: 'error', event: { type: 'TOKEN_STORED' } },
    ];
    for (const { state, event } of cases) {
      const r = reducePairState(state, event);
      expect(r.state).toBe(state);
      expect(r.changed).toBe(false);
    }
  });

  it('终态 done 之后任何事件都不再迁移', () => {
    const events: PairEvent[] = [
      { type: 'PIN_ENTERED' },
      { type: 'SCAN_RECEIVED' },
      { type: 'EXCHANGE_OK' },
      { type: 'EXCHANGE_FAIL', reason: 'x' },
      { type: 'RETRY' },
      { type: 'TOKEN_STORED' },
    ];
    for (const event of events) {
      const r = reducePairState('done', event);
      expect(r.state).toBe('done');
      expect(r.changed).toBe(false);
    }
  });
});
