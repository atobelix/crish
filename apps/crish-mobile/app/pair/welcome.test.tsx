// 配对引导首页路由测试（R2-03 部分 3）：入口跳转（手动输入 → /pair/manual、
// 扫码配对 → /pair/scan）+ 已配对态「进入应用」→ replace (tabs)。
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { authStore } from '@/domain/store/authStore';
import PairWelcomeRoute from './welcome';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));

const pushMock = router.push as jest.Mock;
const replaceMock = router.replace as jest.Mock;

beforeEach(async () => {
  jest.clearAllMocks();
  authStore.getState().revokeLocal();
  await act(async () => {
    authStore.setState({ hydrated: true });
  });
});

describe('配对引导首页路由（R2-03 部分 3）', () => {
  it('点「手动输入配对信息」→ router.push(/pair/manual)', async () => {
    await render(<PairWelcomeRoute />);
    await fireEvent.press(screen.getByTestId('pair-welcome-manual'));
    expect(pushMock).toHaveBeenCalledWith('/pair/manual');
  });

  it('点「扫码配对」→ router.push(/pair/scan)（占位，P2）', async () => {
    await render(<PairWelcomeRoute />);
    await fireEvent.press(screen.getByTestId('pair-welcome-scan'));
    expect(pushMock).toHaveBeenCalledWith('/pair/scan');
  });

  it('已配对态（hydrated 且 paired）→ 进入应用 → router.replace((tabs))', async () => {
    await authStore
      .getState()
      .onPaired(
        { deviceId: 'dev-1', desktopId: 'hub-1', host: '10.0.2.2' },
        { issuedAt: 0, ttlMs: 1000 }
      );
    await render(<PairWelcomeRoute />);
    expect(screen.getByTestId('pair-welcome-paired')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('pair-welcome-enter'));
    expect(replaceMock).toHaveBeenCalledWith('/(tabs)');
  });
});
