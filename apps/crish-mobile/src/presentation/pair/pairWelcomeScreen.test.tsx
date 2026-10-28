// 配对引导首页组件测试（R2-03 部分 3 · R4 批次4 诚实化）：
// 引导文案 + 双入口（手动输入/扫码配对）+ 入口回调（onOpenManual/onOpenScan）、
// 已配对态（authStore hydrated 且 paired → 设备信息 + 进入应用 onEnterApp）、
// 未配对不显示已配对卡片；
// 云端账号（R4 诚实化语义）：登录引导 / 一键直连申请票据失败如实展示错误、
// **不写任何配对态**（配对态唯一入口 = PairingWiring 握手）。
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { authStore } from '@/domain/store/authStore';
import {
  cloudAuthStore,
  configureCloudAuthClient,
} from '@/adapters/cloud/cloudAuthStore';
import type { CloudAuthClient } from '@/network/cloudAuthClient';
import PairWelcomeScreen from './pairWelcomeScreen';

function seedPaired(): Promise<void> {
  return authStore
    .getState()
    .onPaired(
      { deviceId: 'dev-1', desktopId: 'hub-1', host: '192.168.1.5' },
      { issuedAt: 0, ttlMs: 1000 }
    );
}

/** 注入 fake 客户端（票据默认 404 失败——生产现状；用例按需覆盖实现） */
function makeFakeClient(
  ticketError = new Error('申请中继票据失败: Not Found')
): CloudAuthClient & {
  login: jest.Mock;
  listDevices: jest.Mock;
  getClientRelayTicket: jest.Mock;
} {
  return {
    login: jest.fn(async () => ({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      user: { id: 'u-1', email: 'test@flowbit.me' },
    })),
    listDevices: jest.fn(async () => []),
    getClientRelayTicket: jest.fn(async () => {
      throw ticketError;
    }),
  } as never;
}

function resetStores(): void {
  authStore.getState().clearPairing();
  cloudAuthStore.setState({
    isLoggedIn: false,
    user: null,
    devices: [],
    onlineDesktop: null,
    loading: false,
    error: null,
  });
}

beforeEach(async () => {
  resetStores();
  configureCloudAuthClient(makeFakeClient());
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

describe('PairWelcomeScreen 云端账号（R4 批次4 诚实化语义）', () => {
  it('未登录时渲染登录引导卡片，点击打开登录输入框', async () => {
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

  it('已登录并检测到在线桌面 → 一键直连申请票据失败 → 错误如实展示 + 配对态不被伪造', async () => {
    const client = makeFakeClient();
    client.listDevices.mockResolvedValueOnce([
      {
        id: 'desktop-pc-1',
        name: '工作电脑 (Windows)',
        platform: 'desktop',
        lastSeenAt: Date.now(),
        trusted: true,
      },
    ]);
    configureCloudAuthClient(client);

    await act(async () => {
      await cloudAuthStore.getState().login('test@flowbit.me', 'pw');
      await cloudAuthStore.getState().fetchDevices();
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
    const notice = screen.getByTestId('pair-connect-notice').props.children;
    expect(String(notice)).toContain('直连暂不可用');
    expect(String(notice)).toContain('Not Found');
    // 诚实化核心断言：不写配对态、不进应用
    expect(onEnterApp).not.toHaveBeenCalled();
    expect(authStore.getState().pairState).toBe('unpaired');
  });
});
