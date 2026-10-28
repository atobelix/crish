// 设置页视图模型（R2-06 部分 3 · R4 批次2 单真源收敛，M4 §2.2.2 页面唯一数据入口）：
//
// - 数据面：本机偏好 = settingsStore（F6 §4.2 SSOT，settingsDao kv 持久化，重启保留；
//   R4 批次2 起主题/通知偏好不再经旧内存 store）+ 关于（wire 只读：queryPresence 桌面
//   在场/版本 + getSettings 镜像摘要，F6 §3.2 只读参考）+ 配对身份（authStore）；
// - 通知偏好（F6 §10）：总开关 + 场景级开关；权限联动（F6 §10.3）：denied → 开关禁用
//   + 引导文案（notifySwitchGate）；开关首次开（undetermined）→ 先弹系统权限框再落值
//   （requestPermissionOnEnable，请求前建渠道由 permissions.request 内部自保证）；
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
import { useStore } from 'zustand';
import type { JsonValue, PresenceResult } from '@crish/shared-types';
import {
  useConnectionStore,
  useAuthStore,
  useSettingsStore,
} from '@/adapters/hooks/useAppStore';
import { authStore } from '@/domain/store/authStore';
import { settingsStore } from '@/domain/store/settingsStore';
import type { ThemeMode, NotifyScene } from '@/domain/store/settingsReducers';
import { setThemeMode } from '@/adapters/platform/theme';
import {
  getSettingsContext,
  type SettingsContext,
} from '@/adapters/settings/settingsWiring';
import { getPairingWiring } from '@/adapters/wiring/pairing';
import {
  notificationPermissionStore,
  type NotificationPermissionStatus,
} from '@/notifications/permissions';
import {
  notifySwitchGate,
  requestPermissionOnEnable,
  type NotificationSwitchGate,
} from '@/notifications/prefsGate';

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

  // 通用（主题三选，R2UX-06-05；settingsStore 持久化）
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;

  // 通知偏好（F6 §10：总开关 + 场景开关；权限联动 F6 §10.3）
  /** 通知总开关（关闭后场景开关一并失效） */
  notifyMasterOn: boolean;
  /** 场景级开关快照（5 场景；UI 渲染有通道映射的子集） */
  notifyScenes: Readonly<Record<NotifyScene, boolean>>;
  /** 系统通知权限三态（denied → 场景开关禁用 + 引导） */
  notifyPermission: NotificationPermissionStatus;
  /** 权限 → 开关可用性投影（denied → 禁用 + 引导文案，F6 §10.3） */
  notifySwitchGate: NotificationSwitchGate;
  setNotifyMasterOn: (value: boolean) => void;
  /** 场景开关（undetermined → 先请求权限再落值；denied → 拒绝并不落值） */
  setNotifyScene: (scene: NotifyScene, value: boolean) => Promise<void>;

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

/** 权限三态订阅绑定（通知域 store → React；权限 refresh/request 均触发重渲染） */
function useNotificationPermission(): NotificationPermissionStatus {
  return useStore(notificationPermissionStore, (s) => s.status);
}

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
  const themeMode = useSettingsStore((s) => s.groups.appearance.theme);
  const notifyPrefs = useSettingsStore((s) => s.groups.notification);
  const permissionStatus = useNotificationPermission();
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

  // ── 主题（settingsStore.appearance 持久化） ─────────────────────────────
  const changeThemeMode = useCallback((mode: ThemeMode) => {
    setThemeMode(mode);
  }, []);

  // ── 通知偏好（settingsStore.notification 持久化；权限联动 F6 §10.3） ────
  const setNotifyMasterOn = useCallback((value: boolean) => {
    settingsStore.getState().update('notification', { masterOn: value });
  }, []);

  const setNotifyScene = useCallback(
    async (scene: NotifyScene, value: boolean) => {
      // 开关开 + 未询问 → 先弹系统权限框（F6 §10.3 防开了收不到；拒绝则不落值）
      if (value) {
        const status = await requestPermissionOnEnable(
          notificationPermissionStore.getState().status
        );
        if (status === 'denied') return;
      }
      settingsStore.getState().update('notification', {
        sceneFlags: {
          ...settingsStore.getState().groups.notification.sceneFlags,
          [scene]: value,
        },
      });
    },
    []
  );

  // ── 移除本机（注入优先；缺省 defaultRemoveLocal；恒 true 由页面重定向） ──
  const removeLocalFn = removeLocal ?? defaultRemoveLocal;
  const removeLocalAction = useCallback(async (): Promise<boolean> => {
    await removeLocalFn();
    return true;
  }, [removeLocalFn]);

  return {
    connected,
    themeMode,
    setThemeMode: changeThemeMode,
    notifyMasterOn: notifyPrefs.masterOn,
    notifyScenes: notifyPrefs.sceneFlags,
    notifyPermission: permissionStatus,
    notifySwitchGate: notifySwitchGate(permissionStatus),
    setNotifyMasterOn,
    setNotifyScene,
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
