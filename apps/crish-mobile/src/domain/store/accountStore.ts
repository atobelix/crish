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
    selectTarget: (targetDeviceId) => set({ targetDeviceId }),
    setError: (error) => set({ error }),
    reset: () => set({ ...EMPTY, hydrated: true, status: 'loggedOut' }),
  }));
