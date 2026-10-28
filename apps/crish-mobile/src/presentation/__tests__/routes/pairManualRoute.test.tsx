// 手动配对页路由测试（R2-03 部分 3）：整页渲染（输入框 + 连接按钮）+
// 干净输入返回 → router.back()（脏输入走 A4 确认，组件层已覆盖）。
import { fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { authStore } from '@/domain/store/authStore';
import { connectionStore } from '@/domain/store/connectionStore';
import { resetPairingWiringForTest } from '@/adapters/wiring/pairing';
import PairManualRoute from '../../../../app/pair/manual';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));

const backMock = router.back as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  resetPairingWiringForTest();
  authStore.getState().clearPairing();
  connectionStore.setState({ phase: 'disconnected' });
});

afterEach(() => {
  resetPairingWiringForTest();
});

describe('手动配对页路由（R2-03 部分 3）', () => {
  it('整页渲染：主机/配对码输入 + 连接按钮', async () => {
    await render(<PairManualRoute />);
    expect(screen.getByTestId('pair-host-input')).toBeTruthy();
    expect(screen.getByTestId('pair-code-input')).toBeTruthy();
    expect(screen.getByTestId('pair-connect')).toBeTruthy();
  });

  it('干净输入返回 → router.back()（回到配对引导）', async () => {
    await render(<PairManualRoute />);
    await fireEvent.press(screen.getByTestId('pair-manual-back'));
    expect(backMock).toHaveBeenCalledTimes(1);
  });
});
