// devicePresenceStore 单测（适配层，R2-05 观测面）：
// 设备在场计数三态：缺省 null（未知）→ setCount 写入 / 清空。
import { devicePresenceStore } from './devicePresenceStore';

function resetStore(): void {
  devicePresenceStore.setState({ count: null });
}

beforeEach(() => {
  resetStore();
});

describe('devicePresenceStore（F1 状态卡「设备数」数据面）', () => {
  it('缺省 count = null（无数据不伪造 0，R2UX §6.1 P2）', () => {
    expect(devicePresenceStore.getState().count).toBeNull();
  });

  it('setCount 写入已配对设备数（含 0 与正值）', () => {
    devicePresenceStore.getState().setCount(0);
    expect(devicePresenceStore.getState().count).toBe(0);
    devicePresenceStore.getState().setCount(3);
    expect(devicePresenceStore.getState().count).toBe(3);
  });

  it('setCount(null) 回到未知（查询失败不伪造）', () => {
    devicePresenceStore.getState().setCount(2);
    devicePresenceStore.getState().setCount(null);
    expect(devicePresenceStore.getState().count).toBeNull();
  });
});
