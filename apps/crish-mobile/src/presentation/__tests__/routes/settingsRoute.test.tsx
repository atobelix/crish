// 设置页路由测试（R2-06 部分 3）：整页渲染 + 移除本机双保险确认 →
// unpair（authStore 复位）→ 重定向 /pair/welcome（R2UX-06-06 执行后重定向）
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import { router } from 'expo-router';
import { connectionStore } from '@/domain/store/connectionStore';
import { authStore } from '@/domain/store/authStore';
import { resetPairingWiringForTest } from '@/adapters/wiring/pairing';
import SettingsScreen from '../../../../app/(tabs)/settings';

jest.mock('expo-router', () => ({
  router: { replace: jest.fn(), push: jest.fn() },
}));

const replaceMock = router.replace as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  connectionStore.setState({ phase: 'disconnected' });
  resetPairingWiringForTest();
  authStore.getState().clearPairing();
});

describe('设置页（R2-06 部分 3 · R4 批次2 分组收敛）', () => {
  it('整页渲染：分组列表（通用/通知偏好/关于）+ 移除本机（缩略图假开关已删）', async () => {
    await render(<SettingsScreen />);
    expect(screen.getByText('通用')).toBeTruthy();
    expect(screen.getByText('通知偏好')).toBeTruthy();
    expect(screen.getByText('关于')).toBeTruthy();
    expect(screen.queryByText('文件')).toBeNull();
    expect(screen.getByTestId('settings-remove-local')).toBeTruthy();
  });

  it('取消确认 → 不重定向、配对状态保留', async () => {
    await authStore
      .getState()
      .onPaired(
        { deviceId: 'dev-1', desktopId: 'hub-1', host: '192.168.1.5' },
        { issuedAt: 0, ttlMs: 1000 }
      );
    await render(<SettingsScreen />);
    await fireEvent.press(screen.getByTestId('settings-remove-local'));
    await fireEvent.press(screen.getByTestId('settings-remove-cancel'));
    expect(replaceMock).not.toHaveBeenCalled();
    expect(authStore.getState().pairState).toBe('paired');
  });

  it('双保险确认 → authStore 复位 → 重定向 /pair/welcome', async () => {
    await authStore
      .getState()
      .onPaired(
        { deviceId: 'dev-1', desktopId: 'hub-1', host: '192.168.1.5' },
        { issuedAt: 0, ttlMs: 1000 }
      );
    await render(<SettingsScreen />);
    await fireEvent.press(screen.getByTestId('settings-remove-local'));
    // 双保险：确认前先出现后果弹窗（标题 + 后果文案）
    expect(screen.getByTestId('settings-remove-dialog')).toBeTruthy();
    expect(
      screen.getByText(
        '将解除本机与桌面端的配对，清空本机的配对数据与登录状态；移除后需重新配对才能连接。'
      )
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId('settings-remove-confirm'));
    await waitFor(() => {
      expect(authStore.getState().pairState).toBe('unpaired');
      expect(replaceMock).toHaveBeenCalledWith('/pair/welcome');
    });
  });
});
