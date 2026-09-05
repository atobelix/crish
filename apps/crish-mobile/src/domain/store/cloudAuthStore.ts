/**
 * cloudAuthStore.ts — 移动端云端账号与在线桌面发现 Store
 *
 * 宗旨：“一切麻烦的东西在我们这，用户最好是点点就能完成的那种最好了”
 * 手机端登录同一账号后，自动发现用户的在线电脑，一键免扫码免输码直连。
 */

import { createStore, type StoreApi } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';
import {
  CloudAuthClient,
  type MobileUserProfile,
  type MobileCloudDevice,
  type ClientRelayTicket,
} from '@/network/cloudAuthClient';

export interface CloudAuthState {
  isLoggedIn: boolean;
  user: MobileUserProfile | null;
  accessToken: string | null;
  refreshToken: string | null;
  devices: MobileCloudDevice[];
  onlineDesktop: MobileCloudDevice | null;
  loading: boolean;
  error: string | null;

  login: (email: string, pass: string) => Promise<void>;
  logout: () => void;
  fetchDevices: () => Promise<void>;
  requestTicketForDesktop: () => Promise<ClientRelayTicket>;
  clearError: () => void;
}

const client = new CloudAuthClient();

export const cloudAuthStore: StoreApi<CloudAuthState> = createStore<CloudAuthState>()(
  immer((set, get) => ({
    isLoggedIn: false,
    user: null,
    accessToken: null,
    refreshToken: null,
    devices: [],
    onlineDesktop: null,
    loading: false,
    error: null,

    login: async (email: string, pass: string) => {
      set((s) => {
        s.loading = true;
        s.error = null;
      });
      try {
        const { accessToken, refreshToken, user } = await client.login(email, pass);
        set((s) => {
          s.isLoggedIn = true;
          s.user = user;
          s.accessToken = accessToken;
          s.refreshToken = refreshToken;
          s.loading = false;
          s.error = null;
        });
        await get().fetchDevices();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        set((s) => {
          s.loading = false;
          s.error = msg;
        });
        throw err;
      }
    },

    logout: () => {
      set((s) => {
        s.isLoggedIn = false;
        s.user = null;
        s.accessToken = null;
        s.refreshToken = null;
        s.devices = [];
        s.onlineDesktop = null;
        s.error = null;
      });
    },

    fetchDevices: async () => {
      const token = get().accessToken;
      if (!token) return;
      try {
        const devs = await client.listDevices(token);
        // 查找桌面电脑（优先选择最近活跃的桌面端）
        const desktop =
          devs.find(
            (d) =>
              d.platform.toLowerCase().includes('desktop') ||
              d.platform.toLowerCase().includes('windows') ||
              d.platform.toLowerCase().includes('mac')
          ) ?? (devs.length > 0 ? devs[0] : null);

        set((s) => {
          s.devices = devs;
          s.onlineDesktop = desktop ?? null;
        });
      } catch {
        // 忽略静默错误
      }
    },

    requestTicketForDesktop: async () => {
      const token = get().accessToken;
      const desktop = get().onlineDesktop;
      if (!token || !desktop) {
        throw new Error('未检测到可用的在线电脑');
      }
      return await client.getClientRelayTicket(token, desktop.id);
    },

    clearError: () => {
      set((s) => {
        s.error = null;
      });
    },
  }))
);
