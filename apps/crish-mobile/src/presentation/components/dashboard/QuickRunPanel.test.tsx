// QuickRunPanel 组件测试（R2-05 部分 5 快速操作区）：
// - 表单：输入驱动 canSubmit / 空 prompt 禁用 / 提交调用 vm.submit / 回车提交；
// - 反馈：sending（菊花）/ success（回执 runId + 查看详情跳 run 详情）/ error（映射文案）；
// - 会话选择：chips 渲染前 N 个 + 新会话 chip；选中切换调用 vm.selectSession；
// - 未连接态：禁用输入/按钮 + 「未连接」提示；busy 态按钮禁用。
import { fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { QuickRunVm } from '@/adapters/viewmodels/useQuickRunVm';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import { isChipSelected, QuickRunPanel, sessionTitleOf } from './QuickRunPanel';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));

const pushMock = router.push as jest.Mock;

function makeSession(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: 's-1',
    updatedAt: 1000,
    pendingApprovalCount: 0,
    activeRunIds: [],
    ...overrides,
  } as SessionSummary;
}

function makeVm(overrides: Partial<QuickRunVm> = {}): QuickRunVm {
  return {
    connected: true,
    recentSessions: [],
    prompt: '',
    selectedSessionId: null,
    busy: false,
    feedback: { kind: 'idle' },
    canSubmit: false,
    setPrompt: jest.fn(),
    selectSession: jest.fn(),
    submit: jest.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('派生纯函数', () => {
  it('sessionTitleOf：title 缺省/空白 → id 兜底', () => {
    expect(sessionTitleOf('检查 package.json', 's-1')).toBe(
      '检查 package.json'
    );
    expect(sessionTitleOf(undefined, 's-1')).toBe('s-1');
    expect(sessionTitleOf('   ', 's-1')).toBe('s-1');
  });

  it('isChipSelected：null 匹配新会话 chip；id 精确匹配', () => {
    expect(isChipSelected(null, null)).toBe(true);
    expect(isChipSelected(null, 's-1')).toBe(false);
    expect(isChipSelected('s-1', 's-1')).toBe(true);
    expect(isChipSelected('s-2', 's-1')).toBe(false);
  });
});

describe('表单（输入 / 禁用 / 提交）', () => {
  it('空 prompt → 按钮禁用；输入后 canSubmit 驱动使能', async () => {
    const vm = makeVm({ canSubmit: false });
    await render(<QuickRunPanel vm={vm} />);
    expect(screen.getByTestId('quickrun-submit')).toBeDisabled();
    await render(
      <QuickRunPanel vm={makeVm({ canSubmit: true, prompt: 'hi' })} />
    );
    expect(screen.getByTestId('quickrun-submit')).not.toBeDisabled();
  });

  it('输入变化 → vm.setPrompt（受控输入）', async () => {
    const vm = makeVm();
    await render(<QuickRunPanel vm={vm} />);
    await fireEvent.changeText(screen.getByTestId('quickrun-input'), '新任务');
    expect(vm.setPrompt).toHaveBeenCalledWith('新任务');
  });

  it('点按钮 → vm.submit（canSubmit 时）', async () => {
    const vm = makeVm({ canSubmit: true, prompt: 'hi' });
    await render(<QuickRunPanel vm={vm} />);
    await fireEvent.press(screen.getByTestId('quickrun-submit'));
    expect(vm.submit).toHaveBeenCalledTimes(1);
  });

  it('禁用态按钮点击不触发 submit', async () => {
    const vm = makeVm({ canSubmit: false });
    await render(<QuickRunPanel vm={vm} />);
    await fireEvent.press(screen.getByTestId('quickrun-submit'));
    expect(vm.submit).not.toHaveBeenCalled();
  });

  it('回车提交（onSubmitEditing）', async () => {
    const vm = makeVm({ canSubmit: true, prompt: 'hi' });
    await render(<QuickRunPanel vm={vm} />);
    await fireEvent(screen.getByTestId('quickrun-input'), 'submitEditing');
    expect(vm.submit).toHaveBeenCalledTimes(1);
  });
});

describe('反馈（busy / 成功 / 失败映射）', () => {
  it('sending → 菊花 + 「正在发起…」', async () => {
    await render(
      <QuickRunPanel
        vm={makeVm({ busy: true, feedback: { kind: 'sending' } })}
      />
    );
    expect(screen.getByTestId('quickrun-feedback')).toBeTruthy();
    expect(screen.getByText('正在发起…')).toBeTruthy();
    expect(screen.getByTestId('quickrun-submit')).toBeDisabled();
  });

  it('success → 回执 runId 文案 + 查看详情跳 /run/{runId}', async () => {
    await render(
      <QuickRunPanel
        vm={makeVm({
          feedback: { kind: 'success', runId: 'r-42', sessionId: 's-1' },
        })}
      />
    );
    expect(screen.getByText('已发起 · run r-42')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('quickrun-open-run'));
    expect(pushMock).toHaveBeenCalledWith('/run/r-42');
  });

  it('error → 错误码映射文案展示', async () => {
    await render(
      <QuickRunPanel
        vm={makeVm({
          feedback: {
            kind: 'error',
            code: 'cmd.session_busy',
            message: '桌面正在处理该会话，请稍后再试',
          },
        })}
      />
    );
    expect(screen.getByText('桌面正在处理该会话，请稍后再试')).toBeTruthy();
  });
});

describe('会话选择', () => {
  it('无会话 → 不渲染选择区；有会话 → 新会话 chip + 前 N 个 chips', async () => {
    await render(<QuickRunPanel vm={makeVm({ recentSessions: [] })} />);
    expect(screen.queryByTestId('quickrun-session-new')).toBeNull();
    await render(
      <QuickRunPanel
        vm={makeVm({
          recentSessions: [
            makeSession({ id: 's-1', title: '会话A' }),
            makeSession({ id: 's-2' }),
          ],
        })}
      />
    );
    expect(screen.getByTestId('quickrun-session-new')).toBeTruthy();
    expect(screen.getByTestId('quickrun-session-s-1')).toBeTruthy();
    expect(screen.getByText('会话A')).toBeTruthy();
    expect(screen.getByTestId('quickrun-session-s-2')).toBeTruthy();
    expect(screen.getByText('s-2')).toBeTruthy(); // title 缺省 → id 兜底
  });

  it('点 chip → vm.selectSession(id)；点新会话 chip → selectSession(null)', async () => {
    const vm = makeVm({
      recentSessions: [makeSession({ id: 's-1', title: '会话A' })],
    });
    await render(<QuickRunPanel vm={vm} />);
    await fireEvent.press(screen.getByTestId('quickrun-session-s-1'));
    expect(vm.selectSession).toHaveBeenCalledWith('s-1');
    await fireEvent.press(screen.getByTestId('quickrun-session-new'));
    expect(vm.selectSession).toHaveBeenCalledWith(null);
  });

  it('选中 chip 高亮（accessibilityState.selected）', async () => {
    const vm = makeVm({
      selectedSessionId: 's-1',
      recentSessions: [makeSession({ id: 's-1', title: '会话A' })],
    });
    await render(<QuickRunPanel vm={vm} />);
    expect(
      screen.getByTestId('quickrun-session-s-1').props.accessibilityState
    ).toMatchObject({
      selected: true,
    });
    expect(
      screen.getByTestId('quickrun-session-new').props.accessibilityState
    ).toMatchObject({ selected: false });
  });
});

describe('未连接态', () => {
  it('未连接 → 禁用提示 + 输入/按钮不可用', async () => {
    const vm = makeVm({ connected: false, canSubmit: false });
    await render(<QuickRunPanel vm={vm} />);
    expect(screen.getByTestId('quickrun-disconnected')).toBeTruthy();
    expect(screen.getByText('未连接，无法发起任务')).toBeTruthy();
    expect(screen.getByTestId('quickrun-input')).toBeDisabled();
    expect(screen.getByTestId('quickrun-submit')).toBeDisabled();
  });

  it('未连接但已有反馈 → 反馈照常展示（诚实化不隐藏）', async () => {
    await render(
      <QuickRunPanel
        vm={makeVm({
          connected: false,
          feedback: {
            kind: 'error',
            code: 'transport.closed',
            message: '未连接，请检查连接后重试',
          },
        })}
      />
    );
    expect(screen.getByText('未连接，请检查连接后重试')).toBeTruthy();
  });
});
