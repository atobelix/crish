// 账号领域 store（无网络副效应；HTTP / SecureStore 编排在 adapters/account）。

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
  /** 显式选「本机」：目标清空 + 本地钉住（自动选靶让位，见 setDevices） */
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
        // 用户显式选了「本机」（本地钉住）：目标恒为 null——自动选靶不得
        // 把用户改选到远端，否则「选本机」会在下一轮发现心跳（≤15s）内被
        // 静默撤销，等于假选择。解钉只能由显式改选远端（selectTarget）。
        if (state.localTargetPinned) {
          return { devices, targetDeviceId: null };
        }
        // 成功但为空的发现只更新设备列表（当前无在线设备），不撤销既有
        // 目标（CON-1 空发现保护）：目标的去留由后续发现是否命中与资格门
        // 去抖裁决，不由一次空快照清零——否则桌面 presence 一次抖动就
        // 丢目标、整条接线被拆。
        if (devices.length === 0) {
          return { devices, targetDeviceId: state.targetDeviceId };
        }
        const current = devices.find(
          (device) => device.id === state.targetDeviceId
        );
        const onlineDesktop = devices.find(
          (device) => device.platform === 'desktop' && device.online
        );
        const firstDesktop = devices.find(
          (device) => device.platform === 'desktop'
        );
        const nextTarget = current?.online
          ? current.id
          : (onlineDesktop?.id ?? current?.id ?? firstDesktop?.id ?? null);
        return { devices, targetDeviceId: nextTarget };
      }),
    selectTarget: (targetDeviceId) =>
      set({ targetDeviceId, localTargetPinned: false }),
    selectLocalTarget: () =>
      set({ targetDeviceId: null, localTargetPinned: true }),
    setError: (error) => set({ error }),
    reset: () => set({ ...EMPTY, hydrated: true, status: 'loggedOut' }),
  }));
