// 配对引导首页组件测试（R2-03 部分 3）：
// 引导文案 + 双入口（手动输入/扫码配对）+ 入口回调（onOpenManual/onOpenScan）、
// 已配对态（authStore hydrated 且 paired → 设备信息 + 进入应用 onEnterApp）、
// 未配对不显示已配对卡片。
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { authStore } from '@/domain/store/authStore';
import { cloudAuthStore } from '@/domain/store/cloudAuthStore';
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
  authStore.getState().clearPairing();
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

describe('PairWelcomeScreen 云端账号一键直连（免扫码免输码）', () => {
  it('未登录时渲染登录引导卡片，点击打开登录输入框', async () => {
    cloudAuthStore.getState().logout();
    await render(
      <PairWelcomeScreen
        onOpenManual={jest.fn()}
        onOpenScan={jest.fn()}
        onEnterApp={jest.fn()}
      />
    );

    expect(screen.getByTestId('pair-cloud-tip-card')).toBeTruthy();
    expect(screen.queryByTestId('pair-cloud-login-box')).toBeNull();

    await fireEvent.press(screen.getByTestId('pair-open-login'));
    expect(screen.getByTestId('pair-cloud-login-box')).toBeTruthy();
  });

  it('已登录并检测到在线桌面时，显示一键直连按钮，点击完成配对并进入应用', async () => {
    cloudAuthStore.setState({
      isLoggedIn: true,
      user: { id: 'u1', email: 'test@flowbit.me' },
      onlineDesktop: {
        id: 'desktop-pc-1',
        name: '工作电脑 (Windows)',
        platform: 'desktop',
        lastSeenAt: Date.now(),
        trusted: true,
      },
    });

    jest
      .spyOn(cloudAuthStore.getState(), 'requestTicketForDesktop')
      .mockResolvedValueOnce({
        ticket: 'tkt-test',
        relayUrl: 'wss://relay.flowbit.me',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

    const onEnterApp = jest.fn();
    await render(
      <PairWelcomeScreen
        onOpenManual={jest.fn()}
        onOpenScan={jest.fn()}
        onEnterApp={onEnterApp}
      />
    );

    expect(screen.getByTestId('pair-cloud-desktop-card')).toBeTruthy();
    expect(screen.getByText('发现我的电脑：工作电脑 (Windows)')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('pair-one-click-connect'));
    expect(onEnterApp).toHaveBeenCalledTimes(1);
    expect(authStore.getState().pairState).toBe('paired');
  });
});
