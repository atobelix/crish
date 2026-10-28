// 手动配对页组件测试（R2-03 部分 3）：
// 配对码输入实时格式化（formatPairCodeDraft：CXN-XXXX-XXXX-XXXX 展示形态，
// 前缀剥离与 normalizePairCode 同语义）+ 实时校验（非法提示 + 连接可用性）、
// 提交调用 beginPairing({host, code})、本地拒绝错误映射（ok:false）、机器错误
// 映射（pair.invalid_code / pair.too_many_attempts → 人话文案；locked → 冷却
// 文案）、配对中 busy 防双点、返回放弃确认（A4：脏输入弹 Dialog / 取消保留 /
// 放弃配对调用 onBack / 干净直接返回 / Android 硬件返回键拦截）、连接相位标签。
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { BackHandler } from 'react-native';
import { PAIR_INITIAL_STATE } from '@/pairing/pairMachine';
import type {
  PairingInput,
  PairingSnapshot,
  PairingStartResult,
} from '@/adapters/wiring/pairing';
import { connectionStore } from '@/domain/store/connectionStore';
import PairManualScreen, {
  PAIR_ABANDON_DIALOG_DESCRIPTION,
  PAIR_LOCKED_TEXT,
  formatPairCodeDraft,
  pairErrorText,
  pairFailureText,
} from './pairManualScreen';
import type { PairingController } from './pairingBootstrap';

const HOST = '10.0.2.2';
const CODE = 'CXN-7K4P-Q2MB-9XRT';
/** 展示形态剥离前缀/分隔符后的 12 位规范码（输入闭环提取产物） */
const CODE_RAW = '7K4PQ2MB9XRT';

interface FakeHarness {
  controller: PairingController;
  begin: jest.Mock;
  snap: () => PairingSnapshot;
  setSnap: (updater: (s: PairingSnapshot) => PairingSnapshot) => void;
}

/** fake 控制器：beginPairing 可注入实现；缺省进入配对中（sending-hello） */
function makeFakeController(
  beginImpl?: (input: PairingInput) => PairingStartResult
): FakeHarness {
  const listeners = new Set<() => void>();
  let snap: PairingSnapshot = {
    machine: { ...PAIR_INITIAL_STATE },
    error: null,
    sessionPhase: 'disconnected',
  };
  const setSnap: FakeHarness['setSnap'] = (updater) => {
    snap = updater(snap);
    for (const l of [...listeners]) l();
  };
  const begin = jest.fn((input: PairingInput): PairingStartResult => {
    if (beginImpl) return beginImpl(input);
    setSnap((s) => ({
      ...s,
      machine: { ...s.machine, state: 'sending-hello' },
    }));
    return { ok: true };
  });
  const controller: PairingController = {
    beginPairing: begin,
    hydrate: jest.fn(async () => false),
    subscribe: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    getSnapshot: () => snap,
    reset: jest.fn(() => {
      setSnap((s) => ({ ...s, machine: { ...PAIR_INITIAL_STATE } }));
    }),
  };
  return { controller, begin, snap: () => snap, setSnap };
}

/** 输入合法主机 + 配对码（输入框触发） */
async function seedValidInputs(): Promise<void> {
  await fireEvent.changeText(screen.getByTestId('pair-host-input'), HOST);
  await fireEvent.changeText(screen.getByTestId('pair-code-input'), CODE);
}

function backHandlerOf(addSpy: jest.SpyInstance): () => boolean {
  const calls = addSpy.mock.calls.filter((c) => c[0] === 'hardwareBackPress');
  return (calls.at(-1)?.[1] as () => boolean) ?? (() => false);
}

beforeEach(() => {
  connectionStore.setState({ phase: 'disconnected' });
});

describe('formatPairCodeDraft（实时格式化，纯函数）', () => {
  it('空输入 → 空串', () => {
    expect(formatPairCodeDraft('')).toBe('');
  });

  it('小写转大写 + 恒带 CXN- 前缀 + 4 位分组', () => {
    expect(formatPairCodeDraft('7k4pq2mb9xrt')).toBe(CODE);
  });

  it('粘贴完整展示形态（前缀 + 分隔符）→ 正常归一', () => {
    expect(formatPairCodeDraft('CXN-7K4P-Q2MB-9XRT')).toBe(CODE);
  });

  it('12 位裸码以 CXN 起头（正常码）→ 不剥前缀（与 normalizePairCode 同语义）', () => {
    expect(formatPairCodeDraft('CXN123456789')).toBe('CXN-CXN1-2345-6789');
  });

  it('过滤非法字符 + 截断 12 位上限', () => {
    expect(formatPairCodeDraft('a1!b2@c3#d4$e5')).toBe('CXN-A1B2-C3D4-E5');
    expect(formatPairCodeDraft('7K4PQ2MB9XRTTTT')).toBe(CODE);
  });
});

describe('pairErrorText / pairFailureText（错误码映射，纯函数）', () => {
  it('pair.* 与 pairing.* 错误码 → 人话文案', () => {
    expect(pairErrorText('pair.invalid_code')).toBe('配对码无效，请检查后重试');
    expect(pairErrorText('pair.too_many_attempts')).toContain('尝试次数过多');
    expect(pairErrorText('pairing.transport_failed')).toContain(
      '无法连接桌面主机'
    );
    expect(pairErrorText('pairing.persist_failed')).toContain('保存失败');
  });

  it('未知错误码 → 兜底文案', () => {
    expect(pairErrorText('unknown.xyz')).toBe('配对失败，请重试');
  });

  it('快照 error 态按码映射；locked 恒冷却提示；其余为 null', () => {
    const errMachine = (code: string, state: 'error' | 'locked') => ({
      machine: {
        ...PAIR_INITIAL_STATE,
        state,
        error: {
          kind: 'invalid-code' as const,
          code,
          message: '',
          retryable: true,
        },
      },
      error: null,
      sessionPhase: 'disconnected' as const,
    });
    expect(pairFailureText(errMachine('pair.invalid_code', 'error'))).toBe(
      '配对码无效，请检查后重试'
    );
    expect(pairFailureText(errMachine('pair.invalid_code', 'locked'))).toBe(
      PAIR_LOCKED_TEXT
    );
    expect(
      pairFailureText({
        machine: { ...PAIR_INITIAL_STATE },
        error: null,
        sessionPhase: 'disconnected',
      })
    ).toBeNull();
  });
});

describe('PairManualScreen 输入校验与提交', () => {
  it('空输入 → 连接按钮禁用', async () => {
    const { controller } = makeFakeController();
    await render(
      <PairManualScreen controller={controller} onBack={jest.fn()} />
    );
    const btn = screen.getByTestId('pair-connect');
    expect(btn.props.accessibilityState.disabled).toBe(true);
  });

  it('配对码实时格式化展示 + 非法输入提示 + 按钮禁用', async () => {
    const { controller } = makeFakeController();
    await render(
      <PairManualScreen controller={controller} onBack={jest.fn()} />
    );

    await fireEvent.changeText(screen.getByTestId('pair-code-input'), 'abc');
    // 展示形态：大写 + 前缀
    expect(screen.getByTestId('pair-code-input').props.value).toBe('CXN-ABC');
    // 非法 → 提示 + 按钮禁用（host 为空本就禁用，这里断言提示出现）
    expect(screen.getByTestId('pair-code-hint')).toBeTruthy();
  });

  it('完整合法输入 → 提示消失 + 按钮可用', async () => {
    const { controller } = makeFakeController();
    await render(
      <PairManualScreen controller={controller} onBack={jest.fn()} />
    );
    await seedValidInputs();

    expect(screen.queryByTestId('pair-code-hint')).toBeNull();
    expect(
      screen.getByTestId('pair-connect').props.accessibilityState.disabled
    ).toBe(false);
  });

  it('提交 → beginPairing({host, code}) 12 位规范码入参（展示前缀/分隔符已剥离）', async () => {
    const { controller, begin } = makeFakeController();
    await render(
      <PairManualScreen controller={controller} onBack={jest.fn()} />
    );
    await seedValidInputs();

    await fireEvent.press(screen.getByTestId('pair-connect'));
    expect(begin).toHaveBeenCalledTimes(1);
    // DEF-1/2 修复：受控闭环反向提取后，code 为 12 位裸码（无 CXN- 前缀/分隔符）
    expect(begin).toHaveBeenCalledWith({ host: HOST, code: CODE_RAW });
  });

  it('本地拒绝（ok:false）→ 错误文案展示，可改码重试', async () => {
    const { controller, begin } = makeFakeController(() => ({
      ok: false,
      error: '主机不能为空',
    }));
    await render(
      <PairManualScreen controller={controller} onBack={jest.fn()} />
    );
    await seedValidInputs();

    await fireEvent.press(screen.getByTestId('pair-connect'));
    expect(screen.getByTestId('pair-error')).toBeTruthy();
    expect(screen.getByText('主机不能为空')).toBeTruthy();

    // 重试：再次提交仍可调用 beginPairing
    await fireEvent.press(screen.getByTestId('pair-connect'));
    expect(begin).toHaveBeenCalledTimes(2);
  });
});

describe('PairManualScreen DEF-1/2 输入污染回归（受控闭环反向提取）', () => {
  it('逐字符输入完整码 → 每帧展示正确，12 位裸码收束（无 CXN- 前缀/分隔符污染）', async () => {
    const { controller, begin } = makeFakeController();
    await render(
      <PairManualScreen controller={controller} onBack={jest.fn()} />
    );
    const input = screen.getByTestId('pair-code-input');
    const keystrokes = 'KC5QBNTVWH9L'.split('');
    const expectedDisplays = [
      'CXN-K',
      'CXN-KC',
      'CXN-KC5',
      'CXN-KC5Q',
      'CXN-KC5Q-B',
      'CXN-KC5Q-BN',
      'CXN-KC5Q-BNT',
      'CXN-KC5Q-BNTV',
      'CXN-KC5Q-BNTV-W',
      'CXN-KC5Q-BNTV-WH',
      'CXN-KC5Q-BNTV-WH9',
      'CXN-KC5Q-BNTV-WH9L',
    ];
    for (let i = 0; i < keystrokes.length; i += 1) {
      // 原生输入帧 = 当前展示值 + 新字符（真实用户逐字符输入）
      await fireEvent.changeText(input, `${input.props.value}${keystrokes[i]}`);
      expect(input.props.value).toBe(expectedDisplays[i]);
    }
    // 提交 → 接线层收到 12 位规范码
    await fireEvent.changeText(screen.getByTestId('pair-host-input'), HOST);
    await fireEvent.press(screen.getByTestId('pair-connect'));
    expect(begin).toHaveBeenCalledWith({ host: HOST, code: 'KC5QBNTVWH9L' });
  });

  it('单帧粘贴完整展示形态（DEF-2 粘贴主路径）→ 显示不变形', async () => {
    const { controller, begin } = makeFakeController();
    await render(
      <PairManualScreen controller={controller} onBack={jest.fn()} />
    );
    const input = screen.getByTestId('pair-code-input');

    await fireEvent.changeText(input, 'CXN-KC5Q-BNTV-WH9L');
    expect(input.props.value).toBe('CXN-KC5Q-BNTV-WH9L');

    await fireEvent.changeText(screen.getByTestId('pair-host-input'), HOST);
    await fireEvent.press(screen.getByTestId('pair-connect'));
    expect(begin).toHaveBeenCalledWith({ host: HOST, code: 'KC5QBNTVWH9L' });
  });

  it('中途删除字符（退格）→ 提取结果同步收缩，不回灌前缀', async () => {
    const { controller } = makeFakeController();
    await render(
      <PairManualScreen controller={controller} onBack={jest.fn()} />
    );
    const input = screen.getByTestId('pair-code-input');

    await fireEvent.changeText(input, 'CXN-KC5Q-B');
    expect(input.props.value).toBe('CXN-KC5Q-B');
    // 退格 → 原生文本 = 展示值去尾字符
    await fireEvent.changeText(input, 'CXN-KC5Q-');
    expect(input.props.value).toBe('CXN-KC5Q');
    await fireEvent.changeText(input, 'CXN-K');
    expect(input.props.value).toBe('CXN-K');
    await fireEvent.changeText(input, '');
    expect(input.props.value).toBe('');
  });

  it('12 位裸码以 CXN 起头（正常码）→ 反向提取不误剥前缀', async () => {
    const { controller, begin } = makeFakeController();
    await render(
      <PairManualScreen controller={controller} onBack={jest.fn()} />
    );
    const input = screen.getByTestId('pair-code-input');

    // 裸码 CXN7K4PQ2MB9 → 展示 CXN-CXN7-K4PQ-2MB9；再次回传展示值 → 仍还原为裸码
    await fireEvent.changeText(input, 'CXN7K4PQ2MB9');
    expect(input.props.value).toBe('CXN-CXN7-K4PQ-2MB9');
    await fireEvent.changeText(input, input.props.value);
    expect(input.props.value).toBe('CXN-CXN7-K4PQ-2MB9');

    await fireEvent.changeText(screen.getByTestId('pair-host-input'), HOST);
    await fireEvent.press(screen.getByTestId('pair-connect'));
    expect(begin).toHaveBeenCalledWith({ host: HOST, code: 'CXN7K4PQ2MB9' });
  });
});

describe('PairManualScreen 机器错误映射与 busy 防双点', () => {
  it('pair.invalid_code → 映射人话文案（快照驱动）', async () => {
    const { controller, setSnap } = makeFakeController(() => {
      setSnap((s) => ({
        ...s,
        machine: {
          ...s.machine,
          state: 'error',
          error: {
            kind: 'invalid-code',
            code: 'pair.invalid_code',
            message: '',
            retryable: true,
          },
        },
      }));
      return { ok: true };
    });
    await render(
      <PairManualScreen controller={controller} onBack={jest.fn()} />
    );
    await seedValidInputs();

    await fireEvent.press(screen.getByTestId('pair-connect'));
    expect(screen.getByText('配对码无效，请检查后重试')).toBeTruthy();
    // 错误态退出 busy → 按钮恢复可点（可重试）
    expect(
      screen.getByTestId('pair-connect').props.accessibilityState.disabled
    ).toBe(false);
  });

  it('locked → 冷却文案（尝试次数过多）', async () => {
    const { controller, setSnap } = makeFakeController(() => {
      setSnap((s) => ({
        ...s,
        machine: {
          ...s.machine,
          state: 'locked',
          error: {
            kind: 'too-many-attempts',
            code: 'pair.too_many_attempts',
            message: '',
            retryable: false,
          },
        },
      }));
      return { ok: true };
    });
    await render(
      <PairManualScreen controller={controller} onBack={jest.fn()} />
    );
    await seedValidInputs();

    await fireEvent.press(screen.getByTestId('pair-connect'));
    expect(screen.getByText(PAIR_LOCKED_TEXT)).toBeTruthy();
  });

  it('配对中（sending-hello）→ busy：按钮 loading 禁用，重复点击不重复提交', async () => {
    const { controller, begin } = makeFakeController();
    await render(
      <PairManualScreen controller={controller} onBack={jest.fn()} />
    );
    await seedValidInputs();

    await fireEvent.press(screen.getByTestId('pair-connect'));
    expect(begin).toHaveBeenCalledTimes(1);
    const btn = screen.getByTestId('pair-connect');
    expect(btn.props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText('配对中…')).toBeTruthy();

    // 防双点：配对中再点不触发第二次提交
    await fireEvent.press(btn);
    expect(begin).toHaveBeenCalledTimes(1);
  });
});

describe('PairManualScreen 返回放弃确认（A4 裁决）', () => {
  it('脏输入（已输入内容）→ 返回弹 Dialog；取消 → 保留输入不返回', async () => {
    const onBack = jest.fn();
    const { controller } = makeFakeController();
    await render(<PairManualScreen controller={controller} onBack={onBack} />);
    await seedValidInputs();

    await fireEvent.press(screen.getByTestId('pair-manual-back'));
    expect(screen.getByTestId('pair-abandon-dialog')).toBeTruthy();
    expect(screen.getByText(PAIR_ABANDON_DIALOG_DESCRIPTION)).toBeTruthy();

    await fireEvent.press(screen.getByTestId('pair-abandon-cancel'));
    expect(screen.queryByTestId('pair-abandon-dialog')).toBeNull();
    expect(onBack).not.toHaveBeenCalled();
  });

  it('脏输入 → 放弃配对确认 → onBack 恰调用一次', async () => {
    const onBack = jest.fn();
    const { controller } = makeFakeController();
    await render(<PairManualScreen controller={controller} onBack={onBack} />);
    await seedValidInputs();

    await fireEvent.press(screen.getByTestId('pair-manual-back'));
    await fireEvent.press(screen.getByTestId('pair-abandon-confirm'));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('pair-abandon-dialog')).toBeNull();
  });

  it('干净输入 → 返回直接走 onBack（不弹 Dialog）', async () => {
    const onBack = jest.fn();
    const { controller } = makeFakeController();
    await render(<PairManualScreen controller={controller} onBack={onBack} />);

    await fireEvent.press(screen.getByTestId('pair-manual-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('pair-abandon-dialog')).toBeNull();
  });

  it('Android 硬件返回键：脏输入拦截（返回 true + 弹 Dialog）；干净交还系统', async () => {
    const addSpy = jest.spyOn(BackHandler, 'addEventListener');
    const onBack = jest.fn();
    const { controller } = makeFakeController();
    await render(<PairManualScreen controller={controller} onBack={onBack} />);

    // 干净 → 交还系统（false）
    let intercepted = false;
    await act(async () => {
      intercepted = backHandlerOf(addSpy)();
    });
    expect(intercepted).toBe(false);
    expect(screen.queryByTestId('pair-abandon-dialog')).toBeNull();

    // 脏输入 → 拦截（true）+ 弹确认
    await seedValidInputs();
    await act(async () => {
      intercepted = backHandlerOf(addSpy)();
    });
    expect(intercepted).toBe(true);
    expect(screen.getByTestId('pair-abandon-dialog')).toBeTruthy();

    addSpy.mockRestore();
  });
});

describe('PairManualScreen 连接相位标签（connectionStore）', () => {
  it('相位非 disconnected → 展示「连接状态：」标签', async () => {
    connectionStore.setState({ phase: 'connecting' });
    const { controller } = makeFakeController();
    await render(
      <PairManualScreen controller={controller} onBack={jest.fn()} />
    );

    expect(screen.getByTestId('pair-phase')).toBeTruthy();
    expect(screen.getByText('连接状态：连接中…')).toBeTruthy();
  });

  it('相位 disconnected（配对期）→ 不展示标签', async () => {
    const { controller } = makeFakeController();
    await render(
      <PairManualScreen controller={controller} onBack={jest.fn()} />
    );

    expect(screen.queryByTestId('pair-phase')).toBeNull();
  });
});
