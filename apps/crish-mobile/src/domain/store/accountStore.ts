// 账号领域 store（无网络副效应；HTTP / SecureStore 编排在 adapters/account）。
//
// 目标设备主权（2026-11-05 用户裁决）：targetDeviceId 只由用户显式动作
// 改变（selectTarget / selectLocalTarget / 冷启动水合恢复）——设备发现
// 心跳的 setDevices 只更新设备表，严禁自动选靶（旧实现"目标离线即静默
// 改选第一台在线桌面"构成越权状态变更：正在查看的会话面会被整表换成
// 别台设备的快照）。设备上线边沿只做纯提醒（见 accountRuntime 的
// notifyDesktopOnlineEdges），切换永远由用户在设备 Sheet 手动完成。

import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  AccountDevice,
  AccountProfile,
  AccountState,
  AccountUser,
} from '@/domain/types/account';

export interface AccountActions {
  setHydrated: (hydrated: boolean) => void;
  setStatus: (status: AccountState['status']) => void;
  setUser: (user: AccountUser | null) => void;
  setProfile: (profile: AccountProfile | null) => void;
  setAccessToken: (token: string | null) => void;
  setDevices: (devices: AccountDevice[]) => void;
  selectTarget: (deviceId: string | null) => void;
  /** 显式选「本机」：目标清空 + 本地钉住（呈现语义，见 useDeviceStatusVm） */
  selectLocalTarget: () => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export type AccountStoreState = AccountState & AccountActions;

const EMPTY: AccountState = {
  hydrated: false,
  status: 'unknown',
  user: null,
  profile: null,
  accessToken: null,
  devices: [],
  targetDeviceId: null,
  localTargetPinned: false,
  error: null,
};

function isSameDevice(a: AccountDevice, b: AccountDevice): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.platform === b.platform &&
    a.online === b.online &&
    (a as { isOnline?: boolean }).isOnline ===
      (b as { isOnline?: boolean }).isOnline
  );
}

function areDevicesEqual(
  prev: readonly AccountDevice[],
  next: readonly AccountDevice[]
): boolean {
  if (prev === next) return true;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (!isSameDevice(prev[i]!, next[i]!)) {
      return false;
    }
  }
  return true;
}

export const accountStore: StoreApi<AccountStoreState> =
  createStore<AccountStoreState>()((set) => ({
    ...EMPTY,

    setHydrated: (hydrated) => set({ hydrated }),
    setStatus: (status) => set({ status }),
    setUser: (user) => set({ user }),
    setProfile: (profile) => set({ profile }),
    setAccessToken: (accessToken) => set({ accessToken }),
    setDevices: (devices) =>
      set((state) => {
        // 增设数组等值比较（对比元素长度及每一项关键属性）：若与当前
        // state.devices 完全相同，则直接返回原 state，不触发 Zustand 广播，
        // 彻底阻断 15 秒定时心跳全屏重绘！
        if (areDevicesEqual(state.devices, devices)) {
          return state;
        }
        // 只更新设备表，绝不改写 targetDeviceId（2026-11-05 目标主权裁决）：
        // 目标离线与否只影响资格门（accountRuntime.syncAccountRemote 的
        // 去抖拆线）与呈现（DevicePill 离线徽标），不由发现心跳改写用户
        // 选择；上线/切换走提醒 + 用户显式动作。
        return { devices };
      }),
    selectTarget: (targetDeviceId) =>
      set({ targetDeviceId, localTargetPinned: false }),
    selectLocalTarget: () =>
      set({ targetDeviceId: null, localTargetPinned: true }),
    setError: (error) => set({ error }),
    reset: () => set({ ...EMPTY, hydrated: true, status: 'loggedOut' }),
  }));
