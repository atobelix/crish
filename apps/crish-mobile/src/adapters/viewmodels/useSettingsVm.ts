// 设置页视图模型（R2-06 部分 3，M4 §2.2.2 页面唯一数据入口）：
//
// - 数据面：本机偏好（settingsLocalStore：通知偏好 + 缩略图）+ 主题三选
//   （platform/theme）+ 关于（wire 只读：queryPresence 桌面在场/版本 + getSettings
//   镜像摘要，F6 §3.2 只读参考 + F6 §4.2 mirror 不持久化）+ 配对身份
//   （authStore deviceId/desktopId/host）；
// - 连接投影：connectionStore.phase === 'ready' → connected；未连接 → 设置项
//   禁用「未连接」态（任务书：settingsCommands 读取/更新未连接时禁用）；
// - 关于装载：connected 时并行拉 queryPresence + getSettings（竞态防护：per-load
//   序号，过期响应丢弃）；拉取失败 → error 态可重试；断线（loaded 后相位离开
//   ready）→ disconnected 态（F6 §4.2「桌面端离线」诚实化）；
// - 移除本机：removeLocal 可注入（测试注入；缺省 = defaultRemoveLocal →
//   pairingWiring.unpair()：清 secure-store + 断开 + authStore 复位，M5 §6.2；
//   接线未装配时退化为 authStore.clearPairing 内存复位——装配后由 unpair 全量
//   清除，见接线注记）；成功后由页面层重定向 /pair/welcome（R2UX-06-06）。
//
// 只读纪律：本文件只调用既有 store 动作与 settingsCommands 接线 API，不修改 domain。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { JsonValue } from '@crish/shared-types';
import type { PresenceResult } from '@crish/shared-types';
import { useConnectionStore, useAuthStore } from '@/adapters/hooks/useAppStore';
import { authStore } from '@/domain/store/authStore';
import {
  useSettingsLocalStore,
  settingsLocalStore,
  type LocalPreferenceKey,
} from '@/adapters/settings/settingsLocalStore';
import {
  useThemeMode,
  themeModeStore,
  type ThemeMode,
} from '@/adapters/platform/theme';
import {
  getSettingsContext,
  type SettingsContext,
} from '@/adapters/settings/settingsWiring';
import { getPairingWiring } from '@/adapters/wiring/pairing';

// ── 关于页数据模型 ────────────────────────────────────────────────────────

/** 关于区装载态（idle/loading/loaded/error/disconnected，M4 §5.9 三态 + 离线） */
export type AboutStatus =
  'idle' | 'loading' | 'loaded' | 'error' | 'disconnected';

/** getSettings 镜像摘要（F6 §3.2 只读参考；字段脱敏快照，apiKey 由桌面端保证） */
export interface SettingsMirror {
  /** 权限模式（ask/auto 等；只读展示，手机端不可改，F6 §8.1） */
  permissionMode: string | null;
  /** 已信任命令数（只读摘要） */
  trustedCommandCount: number | null;
  /** 活跃模型 profile id（只读摘要） */
  activeProfileId: string | null;
}

/**
 * 镜像快照 → 展示摘要（纯函数，单测面）：settings 为 JsonValue 快照对象，
 * 抽取已知字段，其余字段宽容忽略（生成解析器已做字段级校验）。
 */
export function mirrorInfoOf(settings: JsonValue): SettingsMirror | null {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return null;
  }
  const rec = settings as Record<string, unknown>;
  return {
    permissionMode:
      typeof rec['permissionMode'] === 'string' ? rec['permissionMode'] : null,
    trustedCommandCount:
      typeof rec['trustedCommandCount'] === 'number'
        ? rec['trustedCommandCount']
        : null,
    activeProfileId:
      typeof rec['activeProfileId'] === 'string'
        ? rec['activeProfileId']
        : null,
  };
}

// ── 视图模型 ──────────────────────────────────────────────────────────────

export interface SettingsVm {
  /** 连接是否就绪（phase === 'ready'；否则设置项「未连接」禁用态） */
  connected: boolean;

  // 通用（主题三选，R2UX-06-05）
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;

  // 通知偏好（本机，F6 §10；未连接禁用）
  approvalNotifications: boolean;
  eventNotifications: boolean;
  setApprovalNotifications: (value: boolean) => void;
  setEventNotifications: (value: boolean) => void;

  // 文件（本机，R2UX-06-03；未连接禁用）
  thumbnailWifiOnly: boolean;
  setThumbnailWifiOnly: (value: boolean) => void;

  // 关于（wire 只读镜像，F6 §3.2）
  aboutStatus: AboutStatus;
  /** 桌面在场（queryPresence；null = 未查询到） */
  presence: PresenceResult | null;
  /** 设置镜像摘要（getSettings；null = 未查询到） */
  mirror: SettingsMirror | null;
  /** 桌面连接主机（authStore；未配对 = null） */
  host: string | null;
  /** 桌面 Hub id（authStore） */
  desktopId: string | null;
  /** 本机设备 id（authStore） */
  deviceId: string | null;
  /** 关于区重载（error 态重试 / 手动刷新） */
  refreshAbout: () => void;

  // 移除本机（M5 §6.2 / R2UX-06-06 双保险确认后调用）
  /** 解除配对并清空本机配对数据；成功返回 true（页面层据此重定向） */
  removeLocal: () => Promise<boolean>;
}

export interface SettingsVmOptions {
  /** 设置域上下文（测试注入优先；缺省走 settingsWiring 单例） */
  context?: SettingsContext | null;
  /** 移除本机实现（测试注入；缺省 defaultRemoveLocal） */
  removeLocal?: () => Promise<void>;
}

/** 缺省移除本机：pairingWiring.unpair（清 secure-store + 断开 + authStore 复位）；
 *  接线未装配（启动早期/测试）→ 退化内存复位（接线注记：装配后由 unpair 全量清除） */
export async function defaultRemoveLocal(): Promise<void> {
  const wiring = getPairingWiring();
  if (wiring) {
    await wiring.unpair();
    return;
  }
  authStore.getState().clearPairing();
}

const IDLE_ABOUT = {
  status: 'idle' as AboutStatus,
  presence: null as PresenceResult | null,
  mirror: null as SettingsMirror | null,
};

/**
 * 视图模型（位置参数对齐 useFilesVm 注入风格；context/removeLocal 缺省走接线单例）。
 * 注：调用方（页面/测试）须保持 context 引用稳定——内联新建对象会使 ctxOf 引用
 * 变化 → loadAbout 变化 → 关于装载 effect 每渲染重跑（React 更新深度上限）。
 */
export function useSettingsVm(
  context?: SettingsContext | null,
  removeLocal?: () => Promise<void>
): SettingsVm {
  // ── store 订阅（适配层唯一绑定入口） ───────────────────────────────────
  const phase = useConnectionStore((s) => s.phase);
  const connected = phase === 'ready';
  const prefs = useSettingsLocalStore((s) => s.prefs);
  const themeMode = useThemeMode((s) => s.mode);
  const identity = useAuthStore((s) => ({
    host: s.host,
    desktopId: s.desktopId,
    deviceId: s.deviceId,
  }));

  // ── 本地态（关于区装载） ────────────────────────────────────────────────
  const [about, setAbout] = useState<{
    status: AboutStatus;
    presence: PresenceResult | null;
    mirror: SettingsMirror | null;
  }>(IDLE_ABOUT);
  /** per-load 请求序号（竞态防护：过期响应丢弃，对齐 useFilesVm X4-1） */
  const seqRef = useRef(0);

  /** 上下文（测试注入优先；缺省走接线单例） */
  const ctxOf = useCallback(
    () => (context !== undefined ? context : getSettingsContext()),
    [context]
  );

  // ── 关于装载（connected 时拉 queryPresence + getSettings，F6 §3.2/§4.2） ──
  const loadAbout = useCallback(async (): Promise<void> => {
    const ctx = ctxOf();
    if (!ctx) return; // 未接线：保持现状（未连接态由 connectionStore 投影）
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    setAbout((prev) => ({ ...prev, status: 'loading' }));
    try {
      const [presence, settings] = await Promise.all([
        ctx.repository.queryPresence(),
        ctx.repository.getSettings(),
      ]);
      if (seqRef.current !== seq) return; // 过期响应丢弃
      setAbout({
        status: 'loaded',
        presence,
        mirror: mirrorInfoOf(settings.settings),
      });
    } catch {
      if (seqRef.current !== seq) return;
      setAbout((prev) => ({ ...prev, status: 'error' }));
    }
  }, [ctxOf]);

  // 相位驱动：ready → 自动装载；离开 ready（断线）→ disconnected 态（诚实化）
  useEffect(() => {
    if (!connected) {
      setAbout((prev) =>
        prev.status === 'disconnected'
          ? prev
          : { ...prev, status: 'disconnected' }
      );
      return;
    }
    void loadAbout();
  }, [connected, loadAbout]);

  const refreshAbout = useCallback(() => {
    void loadAbout();
  }, [loadAbout]);

  // ── 主题（platform/theme 存储面） ───────────────────────────────────────
  const setThemeMode = useCallback((mode: ThemeMode) => {
    themeModeStore.getState().setMode(mode);
  }, []);

  // ── 本机偏好开关（settingsLocalStore 存储面） ───────────────────────────
  const setPreference = useCallback(
    (key: LocalPreferenceKey, value: boolean) => {
      settingsLocalStore.getState().setPreference(key, value);
    },
    []
  );

  // ── 移除本机（注入优先；缺省 defaultRemoveLocal） ───────────────────────
  const removeLocalFn = removeLocal ?? defaultRemoveLocal;
  const removeLocalAction = useCallback(async (): Promise<boolean> => {
    await removeLocalFn();
    return true;
  }, [removeLocalFn]);

  return {
    connected,
    themeMode,
    setThemeMode,
    approvalNotifications: prefs.approvalNotifications,
    eventNotifications: prefs.eventNotifications,
    thumbnailWifiOnly: prefs.thumbnailWifiOnly,
    setApprovalNotifications: (value) =>
      setPreference('approvalNotifications', value),
    setEventNotifications: (value) =>
      setPreference('eventNotifications', value),
    setThumbnailWifiOnly: (value) => setPreference('thumbnailWifiOnly', value),
    aboutStatus: about.status,
    presence: about.presence,
    mirror: about.mirror,
    host: identity.host,
    desktopId: identity.desktopId,
    deviceId: identity.deviceId,
    refreshAbout,
    removeLocal: removeLocalAction,
  };
}
