// 设备在场 store（适配层，R2-05 观测面）：桌面侧已配对设备数（F1 状态卡「设备数」数据面）
// - null = 未知（查询未成功/未开始），诚实化纪律（R2UX §6.1 P2：无数据不伪造 0）；
// - 由 FeedBridge open 相位 fire-and-forget 查询 remote.listDevices 驱动（接线层写）。
import { createStore } from 'zustand/vanilla';

export interface DevicePresenceState {
  /** 已配对设备数（含本机？——以桌面设备注册表返回为准）；null = 未知 */
  count: number | null;
  setCount: (count: number | null) => void;
}

export const devicePresenceStore = createStore<DevicePresenceState>()(
  (set) => ({
    count: null,
    setCount: (count) => set({ count }),
  })
);
