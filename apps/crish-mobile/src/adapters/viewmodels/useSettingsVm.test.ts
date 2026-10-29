// 设置域「解除本机」链路测试（defaultRemoveLocal）。
//
// 这是设置页最危险的动作：必须保证「有配对接线 → 走 wiring.unpair（含服务端
// 通知）」，否则只清本地会留下桌面端悬挂的设备记录。
import { defaultRemoveLocal } from './useSettingsVm';
import { authStore } from '@/domain/store/authStore';

jest.mock('@/adapters/wiring/pairing', () => ({
  getPairingWiring: jest.fn(() => null),
}));

import { getPairingWiring } from '@/adapters/wiring/pairing';

const getPairingMock = getPairingWiring as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  authStore.setState({ pairState: 'paired' });
});

describe('defaultRemoveLocal', () => {
  it('有配对接线时走 wiring.unpair（含服务端通知）', async () => {
    const unpair = jest.fn(async () => {});
    getPairingMock.mockReturnValue({ unpair });

    await defaultRemoveLocal();

    expect(unpair).toHaveBeenCalledTimes(1);
  });

  it('wiring.unpair 抛错时向上传播（调用方需感知失败）', async () => {
    getPairingMock.mockReturnValue({
      unpair: jest.fn(async () => {
        throw new Error('unpair failed');
      }),
    });

    await expect(defaultRemoveLocal()).rejects.toThrow('unpair failed');
  });

  it('无配对接线时直接清空本地配对态', async () => {
    getPairingMock.mockReturnValue(null);

    await defaultRemoveLocal();

    expect(authStore.getState().pairState).toBe('unpaired');
  });

  it('无接线且已解绑时保持 unpaired（幂等）', async () => {
    getPairingMock.mockReturnValue(null);
    authStore.setState({ pairState: 'unpaired' });

    await defaultRemoveLocal();

    expect(authStore.getState().pairState).toBe('unpaired');
  });
});
