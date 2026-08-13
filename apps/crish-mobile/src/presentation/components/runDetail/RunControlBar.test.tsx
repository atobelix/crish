// RunControlBar 组件测试（R2-05 部分 6 控制区）：
// - 按钮编排：actions 驱动渲染（暂停/恢复/取消；终态空数组 = 页面不渲染本组件）；
// - 发送：点暂停 → vm.pause；点恢复 → vm.resume；点取消 → 打开确认弹窗（不直接发送）；
// - 二次确认（M4 §6.3 / D4 §5.6）：确认按钮 → vm.confirmCancel；再想想/遮罩 → vm.dismissCancel；
// - 反馈：sending（菊花 + 动作文案）/ success（绿色文案）/ error（错误码映射文案）；
// - busy 防双点：busy 期间全部按钮禁用；未连接 → 禁用 + 提示。
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { RunControlVm } from '@/adapters/viewmodels/useRunControlVm';
import { RunControlBar, runControlFeedbackText } from './RunControlBar';

function makeVm(overrides: Partial<RunControlVm> = {}): RunControlVm {
  return {
    connected: true,
    paused: false,
    busy: false,
    feedback: { kind: 'idle' },
    confirmVisible: false,
    canPause: true,
    canResume: false,
    canCancel: true,
    pause: jest.fn(),
    resume: jest.fn(),
    requestCancel: jest.fn(),
    dismissCancel: jest.fn(),
    confirmCancel: jest.fn(),
    ...overrides,
  };
}

describe('runControlFeedbackText（反馈文案派生）', () => {
  it('sending/success 按动作给文案；idle/error → null（error 走 message）', () => {
    expect(runControlFeedbackText({ kind: 'sending', action: 'pause' })).toBe(
      '暂停中…'
    );
    expect(runControlFeedbackText({ kind: 'success', action: 'cancel' })).toBe(
      '已取消'
    );
    expect(runControlFeedbackText({ kind: 'idle' })).toBeNull();
    expect(
      runControlFeedbackText({
        kind: 'error',
        action: 'pause',
        code: 'x',
        message: 'm',
      })
    ).toBeNull();
  });
});

describe('按钮编排（L2/L3 分级，D4 §5.6）', () => {
  it('running 编排 [暂停, 取消]：两按钮渲染 + 无恢复', async () => {
    const vm = makeVm();
    await render(<RunControlBar actions={['pause', 'cancel']} vm={vm} />);
    expect(screen.getByTestId('run-control-pause')).toBeTruthy();
    expect(screen.getByTestId('run-control-cancel')).toBeTruthy();
    expect(screen.queryByTestId('run-control-resume')).toBeNull();
  });

  it('paused 编排 [恢复, 取消]：恢复 primary + 无暂停', async () => {
    const vm = makeVm({ paused: true, canResume: true, canPause: false });
    await render(<RunControlBar actions={['resume', 'cancel']} vm={vm} />);
    expect(screen.getByTestId('run-control-resume')).toBeTruthy();
    expect(screen.getByText('恢复')).toBeTruthy();
    expect(screen.queryByTestId('run-control-pause')).toBeNull();
  });

  it('unknown 编排 [取消]：仅取消按钮', async () => {
    const vm = makeVm();
    await render(<RunControlBar actions={['cancel']} vm={vm} />);
    expect(screen.getByTestId('run-control-cancel')).toBeTruthy();
    expect(screen.queryByTestId('run-control-pause')).toBeNull();
  });
});

describe('发送与防双点（R2UX-04-03）', () => {
  it('点暂停 → vm.pause；点恢复 → vm.resume', async () => {
    const vm = makeVm({ paused: true, canResume: true, canPause: false });
    await render(<RunControlBar actions={['resume', 'cancel']} vm={vm} />);
    await fireEvent.press(screen.getByTestId('run-control-resume'));
    expect(vm.resume).toHaveBeenCalledTimes(1);
  });

  it('点取消 → vm.requestCancel（不直接发送；发送在确认后）', async () => {
    const vm = makeVm();
    await render(<RunControlBar actions={['pause', 'cancel']} vm={vm} />);
    await fireEvent.press(screen.getByTestId('run-control-cancel'));
    expect(vm.requestCancel).toHaveBeenCalledTimes(1);
    expect(vm.confirmCancel).not.toHaveBeenCalled();
  });

  it('busy 期间全部按钮禁用（防双点视觉面）', async () => {
    const vm = makeVm({ busy: true, canPause: false, canCancel: false });
    await render(<RunControlBar actions={['pause', 'cancel']} vm={vm} />);
    expect(screen.getByTestId('run-control-pause')).toBeDisabled();
    expect(screen.getByTestId('run-control-cancel')).toBeDisabled();
  });

  it('未连接 → 全部禁用 + 「未连接，无法控制 run」提示', async () => {
    const vm = makeVm({
      connected: false,
      canPause: false,
      canResume: false,
      canCancel: false,
    });
    await render(<RunControlBar actions={['pause', 'cancel']} vm={vm} />);
    expect(screen.getByTestId('run-control-disconnected')).toBeTruthy();
    expect(screen.getByText('未连接，无法控制 run')).toBeTruthy();
    expect(screen.getByTestId('run-control-pause')).toBeDisabled();
    expect(screen.getByTestId('run-control-cancel')).toBeDisabled();
  });
});

describe('反馈（sending / success / error）', () => {
  it('sending → 反馈行 + 动作文案（暂停中…）', async () => {
    const vm = makeVm({
      busy: true,
      feedback: { kind: 'sending', action: 'pause' },
    });
    await render(<RunControlBar actions={['pause', 'cancel']} vm={vm} />);
    expect(screen.getByTestId('run-control-feedback')).toBeTruthy();
    expect(screen.getByText('暂停中…')).toBeTruthy();
  });

  it('success → 绿色动作文案（已暂停）', async () => {
    const vm = makeVm({ feedback: { kind: 'success', action: 'pause' } });
    await render(<RunControlBar actions={['pause', 'cancel']} vm={vm} />);
    expect(screen.getByText('已暂停')).toBeTruthy();
  });

  it('error → 错误码映射文案（run 不存在或已结束）', async () => {
    const vm = makeVm({
      feedback: {
        kind: 'error',
        action: 'pause',
        code: 'cmd.not_found',
        message: 'run 不存在或已结束',
      },
    });
    await render(<RunControlBar actions={['pause', 'cancel']} vm={vm} />);
    expect(screen.getByText('run 不存在或已结束')).toBeTruthy();
  });
});

describe('取消二次确认（M4 §6.3 Dialog）', () => {
  it('confirmVisible → 弹窗展示标题/后果 + 危险确认/再想想双按钮', async () => {
    const vm = makeVm({ confirmVisible: true });
    await render(<RunControlBar actions={['pause', 'cancel']} vm={vm} />);
    expect(screen.getByTestId('run-control-confirm-dialog')).toBeTruthy();
    expect(screen.getByText('取消 run？')).toBeTruthy();
    expect(screen.getByText('取消 run')).toBeTruthy();
    expect(screen.getByText('再想想')).toBeTruthy();
  });

  it('确认「取消 run」→ vm.confirmCancel（关闭弹窗 + 发送）', async () => {
    const vm = makeVm({ confirmVisible: true });
    await render(<RunControlBar actions={['pause', 'cancel']} vm={vm} />);
    await fireEvent.press(screen.getByTestId('run-control-confirm-ok'));
    expect(vm.confirmCancel).toHaveBeenCalledTimes(1);
  });

  it('「再想想」/ 遮罩 → vm.dismissCancel（不发送）', async () => {
    const vm = makeVm({ confirmVisible: true });
    await render(<RunControlBar actions={['pause', 'cancel']} vm={vm} />);
    await fireEvent.press(screen.getByTestId('run-control-confirm-cancel'));
    expect(vm.dismissCancel).toHaveBeenCalledTimes(1);
    expect(vm.confirmCancel).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('dialog-backdrop'));
    expect(vm.dismissCancel).toHaveBeenCalledTimes(2);
  });

  it('confirmVisible=false → 弹窗不渲染', async () => {
    const vm = makeVm();
    await render(<RunControlBar actions={['pause', 'cancel']} vm={vm} />);
    expect(screen.queryByTestId('run-control-confirm-dialog')).toBeNull();
  });
});

describe('动作类型完整性（类型面护栏）', () => {
  it('actions 空数组 → 仅反馈/弹窗结构可渲染（页面层负责隐藏）', async () => {
    const vm = makeVm();
    await render(<RunControlBar actions={[]} vm={vm} />);
    expect(screen.queryByTestId('run-control-pause')).toBeNull();
    expect(screen.queryByTestId('run-control-cancel')).toBeNull();
  });
});
