// 配对状态机深化单测（R2-03）：全状态转移表（7 状态 × 7 事件矩阵）
// + 失败计数/重试边界（D3 §4.3 单码上限 5）+ 与协议层接线产物断言
// （pendingHello 构造 / result 存 token / 换码重置计数）

import {
  PAIR_INITIAL_STATE,
  PAIR_MAX_ATTEMPTS,
  reducePairState,
  type PairEvent,
  type PairMachineState,
  type PairState,
} from './pairMachine';

const VALID_CODE = 'CXN-7K4P-Q2MB-9XRT';
const NORMALIZED_CODE = '7K4PQ2MB9XRT';

function stateOf(
  state: PairState,
  over: Partial<PairMachineState> = {}
): PairMachineState {
  return { ...PAIR_INITIAL_STATE, state, ...over };
}

function makeEvent(type: PairEvent['type']): PairEvent {
  switch (type) {
    case 'begin':
      return { type: 'begin' };
    case 'submitCode':
      return { type: 'submitCode', code: VALID_CODE, deviceName: '测试手机' };
    case 'onHelloAck':
      return { type: 'onHelloAck' };
    case 'onPairOk':
      return {
        type: 'onPairOk',
        desktopId: 'crish-desktop',
        ttl: 86400,
        token: 'tok-hex-64',
      };
    case 'onPairError':
      return {
        type: 'onPairError',
        error: {
          kind: 'invalid-code',
          code: 'pair.invalid_code',
          message: '配对码错误',
          retryable: false,
        },
      };
    case 'retry':
      return { type: 'retry' };
    case 'reset':
      return { type: 'reset' };
  }
}

/** 主流程事件序列（idle 到 paired） */
function runHappyPath(): PairMachineState {
  let s = reducePairState(PAIR_INITIAL_STATE, { type: 'begin' });
  s = reducePairState(s, makeEvent('submitCode'));
  s = reducePairState(s, makeEvent('onHelloAck'));
  return reducePairState(s, makeEvent('onPairOk'));
}

describe('pairMachine 初始态与主流程', () => {
  it('初始态为 idle，begin → waiting-input', () => {
    expect(PAIR_INITIAL_STATE.state).toBe('idle');
    expect(PAIR_INITIAL_STATE.changed).toBe(false);
    const s = reducePairState(PAIR_INITIAL_STATE, { type: 'begin' });
    expect(s.state).toBe('waiting-input');
    expect(s.changed).toBe(true);
  });

  it('主路径：idle → waiting-input → sending-hello → waiting-verify → paired', () => {
    const s = runHappyPath();
    expect(s.state).toBe('paired');
    expect(s.result).toEqual({
      desktopId: 'crish-desktop',
      ttl: 86400,
      token: 'tok-hex-64',
    });
    expect(s.failedAttempts).toBe(0);
  });
});

describe('submitCode（校验 CXN 格式 → 构造 hello 接线）', () => {
  it('合法码 → sending-hello，pendingHello 为标准化的 PairHello（对齐 pair.rs 序列化形态）', () => {
    let s = reducePairState(PAIR_INITIAL_STATE, { type: 'begin' });
    s = reducePairState(s, {
      type: 'submitCode',
      code: 'cxn-7k4p-q2mb-9xrt',
      deviceId: 'dev-test-0001',
      deviceName: '我的手机',
      platform: 'android',
    });
    expect(s.state).toBe('sending-hello');
    expect(s.pendingHello).toEqual({
      code: NORMALIZED_CODE,
      deviceId: 'dev-test-0001',
      mobilePub: '',
      mobileLongPub: '',
      deviceName: '我的手机',
      platform: 'android',
    });
    expect(s.lastCode).toBe(NORMALIZED_CODE);
    expect(s.inputError).toBeNull();
  });

  it('非法码 → 停留 waiting-input + inputError，不消耗失败计数', () => {
    let s = reducePairState(PAIR_INITIAL_STATE, { type: 'begin' });
    s = reducePairState(s, {
      type: 'submitCode',
      code: 'BAD-CODE',
      deviceName: 'd',
    });
    expect(s.state).toBe('waiting-input');
    expect(s.changed).toBe(true);
    expect(s.inputError).not.toBeNull();
    expect(s.failedAttempts).toBe(0);
    expect(s.pendingHello).toBeNull();
  });

  it('deviceId 缺省时由协议层自动生成', () => {
    let s = reducePairState(PAIR_INITIAL_STATE, { type: 'begin' });
    s = reducePairState(s, {
      type: 'submitCode',
      code: VALID_CODE,
      deviceName: 'd',
    });
    expect(s.pendingHello?.deviceId).toMatch(/^dev-[A-Z0-9]{10}$/);
  });

  it('sending-hello / waiting-verify / paired 等非输入态 submitCode → 拒绝', () => {
    const sending = reducePairState(PAIR_INITIAL_STATE, { type: 'begin' });
    const busy = reducePairState(sending, makeEvent('submitCode'));
    expect(reducePairState(busy, makeEvent('submitCode')).changed).toBe(false);
    expect(
      reducePairState(runHappyPath(), makeEvent('submitCode')).changed
    ).toBe(false);
  });
});

describe('onHelloAck / onPairOk（桌面端简化链 hello → ok 接线）', () => {
  it('onHelloAck：sending-hello → waiting-verify', () => {
    let s = reducePairState(PAIR_INITIAL_STATE, { type: 'begin' });
    s = reducePairState(s, makeEvent('submitCode'));
    const acked = reducePairState(s, makeEvent('onHelloAck'));
    expect(acked.state).toBe('waiting-verify');
  });

  it('onHelloAck 非 sending-hello 态 → 拒绝', () => {
    expect(
      reducePairState(PAIR_INITIAL_STATE, makeEvent('onHelloAck')).changed
    ).toBe(false);
    const idle2 = reducePairState(PAIR_INITIAL_STATE, { type: 'begin' });
    expect(reducePairState(idle2, makeEvent('onHelloAck')).changed).toBe(false);
  });

  it('onPairOk：waiting-verify → paired，result 存 token（接线层持久化产物）', () => {
    const s = runHappyPath();
    expect(s.state).toBe('paired');
    expect(s.result?.token).toBe('tok-hex-64');
    expect(s.result?.desktopId).toBe('crish-desktop');
    expect(s.result?.ttl).toBe(86400);
  });

  it('onPairOk 非 waiting-verify 态 → 拒绝', () => {
    const entered = reducePairState(PAIR_INITIAL_STATE, { type: 'begin' });
    expect(reducePairState(entered, makeEvent('onPairOk')).changed).toBe(false);
    const sending = reducePairState(entered, makeEvent('submitCode'));
    expect(reducePairState(sending, makeEvent('onPairOk')).changed).toBe(false);
  });
});

describe('onPairError（错误码映射 → 状态 + 失败计数）', () => {
  /** 从 waiting-verify 触发一次 onPairError 的快速路径 */
  function failOnce(): PairMachineState {
    let s = reducePairState(PAIR_INITIAL_STATE, { type: 'begin' });
    s = reducePairState(s, makeEvent('submitCode'));
    s = reducePairState(s, makeEvent('onHelloAck'));
    return reducePairState(s, makeEvent('onPairError'));
  }

  it('错误码 → error 态 + failedAttempts=1（错误信息保留）', () => {
    const s = failOnce();
    expect(s.state).toBe('error');
    expect(s.failedAttempts).toBe(1);
    expect(s.error?.kind).toBe('invalid-code');
    expect(s.error?.code).toBe('pair.invalid_code');
  });

  it('sending-hello 阶段（hello 被拒）同样进入 error 并计数', () => {
    let s = reducePairState(PAIR_INITIAL_STATE, { type: 'begin' });
    s = reducePairState(s, makeEvent('submitCode'));
    const failed = reducePairState(s, makeEvent('onPairError'));
    expect(failed.state).toBe('error');
    expect(failed.failedAttempts).toBe(1);
  });

  it('连续失败：第 4 次仍 error，第 5 次（PAIR_MAX_ATTEMPTS）→ locked', () => {
    let s = reducePairState(PAIR_INITIAL_STATE, { type: 'begin' });
    s = reducePairState(s, makeEvent('submitCode'));
    s = reducePairState(s, makeEvent('onHelloAck'));
    for (let i = 1; i <= PAIR_MAX_ATTEMPTS; i += 1) {
      s = reducePairState(s, makeEvent('onPairError'));
      const expected = i >= PAIR_MAX_ATTEMPTS ? 'locked' : 'error';
      expect(s.state).toBe(expected);
      expect(s.failedAttempts).toBe(i);
      if (s.state !== 'locked') {
        // 重试重发：回输入 → 同码提交 → 等 ack（计数保留，继续累计）
        s = reducePairState(s, makeEvent('retry'));
        s = reducePairState(s, makeEvent('submitCode'));
        s = reducePairState(s, makeEvent('onHelloAck'));
      }
    }
  });

  it('pair.too_many_attempts → 无论计数多少直接 locked（并计一次失败）', () => {
    let s = reducePairState(PAIR_INITIAL_STATE, { type: 'begin' });
    s = reducePairState(s, makeEvent('submitCode'));
    s = reducePairState(s, makeEvent('onHelloAck'));
    s = reducePairState(s, {
      type: 'onPairError',
      error: {
        kind: 'too-many-attempts',
        code: 'pair.too_many_attempts',
        message: '锁定',
        retryable: false,
      },
    });
    expect(s.state).toBe('locked');
    expect(s.failedAttempts).toBe(1);
  });

  it('error 态继续收到 onPairError → 拒绝（非法转换，不重复计数）', () => {
    const s = failOnce();
    const again = reducePairState(s, makeEvent('onPairError'));
    expect(again.changed).toBe(false);
    expect(again.failedAttempts).toBe(1);
  });

  it('onPairError 在 idle / waiting-input / paired → 拒绝', () => {
    expect(
      reducePairState(PAIR_INITIAL_STATE, makeEvent('onPairError')).changed
    ).toBe(false);
    const entered = reducePairState(PAIR_INITIAL_STATE, { type: 'begin' });
    expect(reducePairState(entered, makeEvent('onPairError')).changed).toBe(
      false
    );
    expect(
      reducePairState(runHappyPath(), makeEvent('onPairError')).changed
    ).toBe(false);
  });
});

describe('重试边界与 reset', () => {
  it('retry：error → waiting-input，失败计数保留（同码继续累计）', () => {
    let s = reducePairState(PAIR_INITIAL_STATE, { type: 'begin' });
    s = reducePairState(s, makeEvent('submitCode'));
    s = reducePairState(s, makeEvent('onHelloAck'));
    s = reducePairState(s, makeEvent('onPairError'));
    const retried = reducePairState(s, makeEvent('retry'));
    expect(retried.state).toBe('waiting-input');
    expect(retried.failedAttempts).toBe(1);
    expect(retried.error?.kind).toBe('invalid-code');
  });

  it('同码重试继续累计至上限：1 次失败 + retry + 再失败 4 次 → locked', () => {
    let s = reducePairState(PAIR_INITIAL_STATE, { type: 'begin' });
    const failAndRetry = (n: number) => {
      for (let i = 0; i < n; i += 1) {
        s = reducePairState(s, makeEvent('onPairError'));
        if (s.state !== 'locked') {
          s = reducePairState(s, makeEvent('retry'));
          s = reducePairState(s, makeEvent('submitCode'));
          s = reducePairState(s, makeEvent('onHelloAck'));
        }
      }
    };
    s = reducePairState(s, makeEvent('submitCode'));
    s = reducePairState(s, makeEvent('onHelloAck'));
    failAndRetry(PAIR_MAX_ATTEMPTS);
    expect(s.state).toBe('locked');
  });

  it('换码 → 本地失败计数重置（新码 = 新会话语义）', () => {
    let s = reducePairState(PAIR_INITIAL_STATE, { type: 'begin' });
    s = reducePairState(s, makeEvent('submitCode'));
    s = reducePairState(s, makeEvent('onHelloAck'));
    s = reducePairState(s, makeEvent('onPairError'));
    // 重试重发（同码）→ 再失败：计数累计到 2
    s = reducePairState(s, makeEvent('retry'));
    s = reducePairState(s, makeEvent('submitCode'));
    s = reducePairState(s, makeEvent('onHelloAck'));
    s = reducePairState(s, makeEvent('onPairError'));
    expect(s.failedAttempts).toBe(2);
    // 改码重提交：计数归零
    s = reducePairState(s, makeEvent('retry'));
    s = reducePairState(s, {
      type: 'submitCode',
      code: 'CXN-ABCD-EFGH-JKMN',
      deviceName: '测试手机',
    });
    expect(s.state).toBe('sending-hello');
    expect(s.failedAttempts).toBe(0);
    // 新码失败一次 → 1；再次提交同一新码 → 计数保留
    s = reducePairState(s, makeEvent('onHelloAck'));
    s = reducePairState(s, makeEvent('onPairError'));
    expect(s.failedAttempts).toBe(1);
    s = reducePairState(s, makeEvent('retry'));
    s = reducePairState(s, {
      type: 'submitCode',
      code: 'CXN-ABCD-EFGH-JKMN',
      deviceName: '测试手机',
    });
    expect(s.failedAttempts).toBe(1);
  });

  it('retry 在非 error 态（含 locked）→ 拒绝', () => {
    expect(
      reducePairState(PAIR_INITIAL_STATE, makeEvent('retry')).changed
    ).toBe(false);
    const locked = stateOf('locked');
    expect(reducePairState(locked, makeEvent('retry')).changed).toBe(false);
  });

  it('reset：locked → idle 清空全部（重新开启配对）', () => {
    const locked = stateOf('locked', {
      failedAttempts: 5,
      error: {
        kind: 'too-many-attempts',
        code: 'x',
        message: '',
        retryable: false,
      },
    });
    const s = reducePairState(locked, makeEvent('reset'));
    expect(s.state).toBe('idle');
    expect(s.changed).toBe(true);
    expect(s.failedAttempts).toBe(0);
    expect(s.error).toBeNull();
    expect(s.pendingHello).toBeNull();
    expect(s.result).toBeNull();
  });

  it('reset：error / waiting-input / sending-hello / waiting-verify 均可回 idle', () => {
    for (const st of [
      'error',
      'waiting-input',
      'sending-hello',
      'waiting-verify',
    ] as const) {
      const r = reducePairState(stateOf(st), makeEvent('reset'));
      expect(r.state).toBe('idle');
      expect(r.changed).toBe(true);
    }
  });

  it('reset：idle / paired → 拒绝（paired 为终态）', () => {
    expect(
      reducePairState(PAIR_INITIAL_STATE, makeEvent('reset')).changed
    ).toBe(false);
    expect(reducePairState(runHappyPath(), makeEvent('reset')).changed).toBe(
      false
    );
  });
});

describe('全状态 × 全事件转移矩阵（7 × 7）', () => {
  const STATES: PairState[] = [
    'idle',
    'waiting-input',
    'sending-hello',
    'waiting-verify',
    'paired',
    'error',
    'locked',
  ];
  const EVENT_TYPES = [
    'begin',
    'submitCode',
    'onHelloAck',
    'onPairOk',
    'onPairError',
    'retry',
    'reset',
  ] as const;

  /** 合法转换表：(状态, 事件) → 目标状态（error 入口计数从 0 起 → error） */
  const LEGAL: Record<
    PairState,
    Partial<Record<(typeof EVENT_TYPES)[number], PairState>>
  > = {
    idle: { begin: 'waiting-input' },
    'waiting-input': { submitCode: 'sending-hello', reset: 'idle' },
    'sending-hello': {
      onHelloAck: 'waiting-verify',
      onPairError: 'error',
      reset: 'idle',
    },
    'waiting-verify': {
      onPairOk: 'paired',
      onPairError: 'error',
      reset: 'idle',
    },
    paired: {},
    error: { retry: 'waiting-input', reset: 'idle' },
    locked: { reset: 'idle' },
  };

  it('矩阵全量断言：合法组合迁移到目标态，其余全部拒绝（changed=false）', () => {
    for (const from of STATES) {
      for (const type of EVENT_TYPES) {
        const base = stateOf(from);
        const r = reducePairState(base, makeEvent(type));
        const expected = LEGAL[from][type];
        if (expected !== undefined) {
          expect(r.state).toBe(expected);
          expect(r.changed).toBe(true);
        } else {
          expect(r.state).toBe(from);
          expect(r.changed).toBe(false);
        }
      }
    }
  });
});
