/**
 * authStore.ts — 全局账号与多端在线设备状态管理
 *
 * 核心职责：
 * 1. 启动时自动获取 Rust 侧会话快照（DPAPI 凭据恢复）；
 * 2. 维持登录态、当前用户信息与账号内在线设备列表（中继房间状态）；
 * 3. 提供登录 / 登出 / 在线设备刷新等全局状态变更动作；
 * 4. 驱动 Sidebar 用户头像与设置「账户」分区视图联动。
 */

import { create } from 'zustand';
import {
  type AccountProfile,
  type AuthSessionInfo,
  type CloudDeviceItem,
  type UserProfile,
  authDeleteAccount,
  authGetProfile,
  authGetSession,
  authListDevices,
  authListSessions,
  authLogin,
  authLogout,
  authRevokeSession,
  authUpdateProfile,
  authUploadAvatar,
} from '../api/authApi';

export interface AuthState {
  isLoggedIn: boolean;
  user: UserProfile | null;
  profile: AccountProfile | null;
  devices: CloudDeviceItem[];
  sessions: AuthSessionInfo[];
  sessionsLoading: boolean;
  profileSaving: boolean;
  loading: boolean;
  initialized: boolean;
  error: string | null;

  initSession: () => Promise<void>;
  login: (email: string, pass: string) => Promise<void>;
  completeLogin: (user: UserProfile) => Promise<void>;
  logout: () => Promise<void>;
  loadDevices: () => Promise<void>;
  loadProfile: () => Promise<void>;
  saveProfile: (input: { displayName?: string; bio?: string }) => Promise<void>;
  uploadAvatar: (dataUrl: string, fileName?: string) => Promise<void>;
  loadSessions: () => Promise<void>;
  revokeSession: (sessionId: string) => Promise<boolean>;
  /** 退出除本机外的全部登录会话；全部成功返回 true */
  revokeOtherSessions: () => Promise<boolean>;
  /** 注销账号：成功（服务端校验确认邮箱）后回到未登录态；失败原样抛出 */
  deleteAccount: (confirmEmail: string) => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  isLoggedIn: false,
  user: null,
  profile: null,
  devices: [],
  sessions: [],
  sessionsLoading: false,
  profileSaving: false,
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
        // 自动拉取资料与在线设备
        void get().loadProfile();
        void get().loadDevices();
      } else {
        set({
          isLoggedIn: false,
          user: null,
          profile: null,
          devices: [],
          sessions: [],
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
      await get().completeLogin(profile);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ loading: false, error: msg });
      throw err;
    }
  },

  completeLogin: async (user: UserProfile) => {
    set({
      isLoggedIn: true,
      user,
      initialized: true,
      loading: false,
      error: null,
    });
    await Promise.all([get().loadProfile(), get().loadDevices()]);
  },

  logout: async () => {
    set({ loading: true });
    try {
      await authLogout();
    } finally {
      set({
        isLoggedIn: false,
        user: null,
        profile: null,
        devices: [],
        sessions: [],
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

  loadProfile: async () => {
    try {
      const profile = await authGetProfile();
      set({ profile });
    } catch {
      // 静默失败：资料读取不阻塞主流程
    }
  },

  saveProfile: async (input) => {
    set({ profileSaving: true, error: null });
    try {
      const profile = await authUpdateProfile(input);
      set((state) => ({
        profile,
        user: state.user
          ? { ...state.user, name: profile.displayName }
          : state.user,
        profileSaving: false,
      }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ profileSaving: false, error: msg });
      throw err;
    }
  },

  uploadAvatar: async (dataUrl, fileName) => {
    set({ profileSaving: true, error: null });
    try {
      const profile = await authUploadAvatar(dataUrl, fileName);
      set({ profile, profileSaving: false });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ profileSaving: false, error: msg });
      throw err;
    }
  },

  loadSessions: async () => {
    set({ sessionsLoading: true });
    try {
      const sessions = await authListSessions();
      set({ sessions, sessionsLoading: false });
    } catch {
      set({ sessionsLoading: false });
    }
  },

  revokeSession: async (sessionId) => {
    try {
      await authRevokeSession(sessionId);
      await get().loadSessions();
      return true;
    } catch {
      return false;
    }
  },

  revokeOtherSessions: async () => {
    const others = get().sessions.filter(
      (session) => !session.current && !session.revoked
    );
    const results = await Promise.allSettled(
      others.map((session) => authRevokeSession(session.id))
    );
    await get().loadSessions();
    return results.every((result) => result.status === 'fulfilled');
  },

  deleteAccount: async (confirmEmail: string) => {
    await authDeleteAccount(confirmEmail);
    set({
      isLoggedIn: false,
      user: null,
      profile: null,
      devices: [],
      sessions: [],
      loading: false,
      error: null,
    });
  },

  clearError: () => set({ error: null }),
}));
