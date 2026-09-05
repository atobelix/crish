/**
 * authStore.ts — 全局账号与多端在线设备状态管理
 *
 * 核心职责：
 * 1. 启动时自动获取 Rust 侧会话快照（DPAPI 凭据恢复）；
 * 2. 维持登录态、当前用户信息与名下绑定的云端设备列表；
 * 3. 提供登录、登出、设备踢出及静默刷新等全局状态变更动作；
 * 4. 驱动 Sidebar 用户头像绿点与 SettingsProfileTab 视图联动。
 */

import { create } from 'zustand';
import {
  type UserProfile,
  type CloudDeviceItem,
  authLogin,
  authLogout,
  authGetSession,
  authListDevices,
  authRevokeDevice,
} from '../api/authApi';

export interface AuthState {
  isLoggedIn: boolean;
  user: UserProfile | null;
  devices: CloudDeviceItem[];
  loading: boolean;
  initialized: boolean;
  error: string | null;

  initSession: () => Promise<void>;
  login: (email: string, pass: string) => Promise<void>;
  logout: () => Promise<void>;
  loadDevices: () => Promise<void>;
  revokeDevice: (deviceId: string) => Promise<boolean>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  isLoggedIn: false,
  user: null,
  devices: [],
  loading: false,
  initialized: false,
  error: null,

  initSession: async () => {
    try {
      const snap = await authGetSession();
      if (snap && snap.is_logged_in) {
        set({
          isLoggedIn: true,
          user: snap.user,
          initialized: true,
          error: null,
        });
        // 自动拉取设备列表
        void get().loadDevices();
      } else {
        set({
          isLoggedIn: false,
          user: null,
          devices: [],
          initialized: true,
          error: null,
        });
      }
    } catch {
      set({
        isLoggedIn: false,
        user: null,
        initialized: true,
      });
    }
  },

  login: async (email: string, pass: string) => {
    set({ loading: true, error: null });
    try {
      const profile = await authLogin(email, pass);
      set({
        isLoggedIn: true,
        user: profile,
        loading: false,
        error: null,
      });
      void get().loadDevices();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ loading: false, error: msg });
      throw err;
    }
  },

  logout: async () => {
    set({ loading: true });
    try {
      await authLogout();
    } finally {
      set({
        isLoggedIn: false,
        user: null,
        devices: [],
        loading: false,
        error: null,
      });
    }
  },

  loadDevices: async () => {
    try {
      const devs = await authListDevices();
      set({ devices: devs });
    } catch {
      // 静默失败，不打断主流程
    }
  },

  revokeDevice: async (deviceId: string) => {
    try {
      const ok = await authRevokeDevice(deviceId);
      if (ok) {
        set((state) => ({
          devices: state.devices.filter((d) => d.id !== deviceId),
        }));
        return true;
      }
      return false;
    } catch {
      return false;
    }
  },

  clearError: () => set({ error: null }),
}));
