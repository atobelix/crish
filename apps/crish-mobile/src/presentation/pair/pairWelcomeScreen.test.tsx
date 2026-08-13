// 配对引导首页组件测试（R2-03 部分 3）：
// 引导文案 + 双入口（手动输入/扫码配对）+ 入口回调（onOpenManual/onOpenScan）、
// 已配对态（authStore hydrated 且 paired → 设备信息 + 进入应用 onEnterApp）、
// 未配对不显示已配对卡片。
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { authStore } from '@/domain/store/authStore';
import PairWelcomeScreen from './pairWelcomeScreen';

function seedPaired(): Promise<void> {
  return authStore
    .getState()
    .onPaired(
      { deviceId: 'dev-1', desktopId: 'hub-1', host: '192.168.1.5' },
      { issuedAt: 0, ttlMs: 1000 }
    );
}

beforeEach(async () => {
  authStore.getState().revokeLocal();
  await act(async () => {
    authStore.setState({ hydrated: true });
  });
});

describe('PairWelcomeScreen 引导（R2-03 部分 3）', () => {
  it('渲染引导文案与双入口（手动输入 / 扫码配对）', async () => {
    await render(
      <PairWelcomeScreen
        onOpenManual={jest.fn()}
        onOpenScan={jest.fn()}
        onEnterApp={jest.fn()}
      />
    );

    expect(screen.getByText('配对桌面主机')).toBeTruthy();
    expect(
      screen.getByText(
        '在桌面端开启配对模式，然后在手机上输入主机 IP 与配对码即可完成配对。'
      )
    ).toBeTruthy();
    expect(screen.getByTestId('pair-welcome-manual')).toBeTruthy();
    expect(screen.getByTestId('pair-welcome-scan')).toBeTruthy();
  });

  it('点「手动输入配对信息」→ onOpenManual（跳 manual 页）', async () => {
    const onOpenManual = jest.fn();
    await render(
      <PairWelcomeScreen
        onOpenManual={onOpenManual}
        onOpenScan={jest.fn()}
        onEnterApp={jest.fn()}
      />
    );

    await fireEvent.press(screen.getByTestId('pair-welcome-manual'));
    expect(onOpenManual).toHaveBeenCalledTimes(1);
  });

  it('点「扫码配对」→ onOpenScan（跳 scan 占位页）', async () => {
    const onOpenScan = jest.fn();
    await render(
      <PairWelcomeScreen
        onOpenManual={jest.fn()}
        onOpenScan={onOpenScan}
        onEnterApp={jest.fn()}
      />
    );

    await fireEvent.press(screen.getByTestId('pair-welcome-scan'));
    expect(onOpenScan).toHaveBeenCalledTimes(1);
  });
});

describe('PairWelcomeScreen 已配对态（hydrated 且 paired）', () => {
  it('显示已配对设备信息 + 进入应用（onEnterApp）', async () => {
    await seedPaired();
    const onEnterApp = jest.fn();
    await render(
      <PairWelcomeScreen
        onOpenManual={jest.fn()}
        onOpenScan={jest.fn()}
        onEnterApp={onEnterApp}
      />
    );

    expect(screen.getByTestId('pair-welcome-paired')).toBeTruthy();
    expect(screen.getByText('主机：192.168.1.5')).toBeTruthy();
    expect(screen.getByText('桌面端：hub-1')).toBeTruthy();
    expect(screen.getByText('本机：dev-1')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('pair-welcome-enter'));
    expect(onEnterApp).toHaveBeenCalledTimes(1);
  });

  it('未配对（unpaired）→ 不显示已配对卡片', async () => {
    await render(
      <PairWelcomeScreen
        onOpenManual={jest.fn()}
        onOpenScan={jest.fn()}
        onEnterApp={jest.fn()}
      />
    );

    expect(screen.queryByTestId('pair-welcome-paired')).toBeNull();
  });
});
