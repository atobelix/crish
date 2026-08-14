// 系统通知面能力门面（P0-1 DEF-5 修复）：expo-notifications 运行时惰性加载 + 降级
// - 背景：Expo Go（SDK 53+）移除 push 原生模块——模块图求值即抛错（index.ts →
//   TokenEmitter → requireNativeModule('ExpoPushTokenManager') 无原生模块；Android
//   Expo Go 下 warnOfExpoGoPushUsage 直接 throw）。静态 import 会把通知层拉进全部
//   路由可达链，任一路由加载即崩（DEF-5，R2-16-acceptance-execution.md §9-14）；
// - 本文件是全仓唯一加载 expo-notifications 的位置：其余通知层模块一律经本门面
//   调用系统通知 API；加载/调用失败 → 系统通知面整体降级（应用内通知 only，
//   ingest 恒保留），不崩溃不阻塞启动；
// - 惰性机制：CommonJS 宿主（Metro / jest）下用运行时 require（模块体在首次调用
//   时才求值——Expo Go 求值抛错被 try/catch 捕获降级；Metro 静态分析仍会把模块
//   打入 bundle，但不会在启动时求值）。原生动态 import() 在 jest 默认环境
//   （未开 --experimental-vm-modules）不可用，故统一走 require；
// - 结构兼容面：与权限/前台/深链模块的子集类型对齐（PermissionStatusLike /
//   SystemNotificationLike / NotificationResponseLike），不依赖 expo 精确类型；
//   import type 编译期擦除，不产生运行时加载；
// - 长期方案注记：dev build（expo-dev-client）为推送联调载体（Expo Go 不支持
//   远程推送——Expo 官方说明），本门面保证 Expo Go 下 app 可用（应用内通知）。

// Metro / jest 宿主全局 require（模块作用域声明；仅本文件惰性加载用）
declare const require: (id: string) => unknown;

import type { PermissionStatusLike } from './permissions';
import type { SystemNotificationLike } from './foreground';
import type { NotificationResponseLike } from './deepLink';

/** Android 渠道重要性枚举键（对齐 expo AndroidImportance 键；注册时经模块取值） */
export type AndroidImportanceKey =
  | 'UNKNOWN'
  | 'UNSPECIFIED'
  | 'NONE'
  | 'MIN'
  | 'LOW'
  | 'DEFAULT'
  | 'HIGH'
  | 'MAX';

/** 渠道输入结构子集（setNotificationChannelAsync 实参面；与 expo 输入同构） */
export interface NotificationChannelInputLike {
  name: string;
  description: string;
  importance: number;
  vibrationPattern?: number[];
}

/** 后台系统通知请求结构子集（content 契约 + 通道 trigger；对齐 presentSystemPushAsync） */
export interface NotificationRequestLike {
  content: {
    title: string;
    body: string | null;
    data: Record<string, unknown>;
  };
  trigger: { channelId: string };
}

/** 运行时模块结构子集（与 expo-notifications 模块对象兼容；仅本层使用面） */
export interface ExpoNotificationsRuntime {
  AndroidImportance: Record<AndroidImportanceKey, number>;
  getPermissionsAsync: () => Promise<PermissionStatusLike>;
  requestPermissionsAsync: () => Promise<PermissionStatusLike>;
  setNotificationChannelAsync: (
    channelId: string,
    channel: NotificationChannelInputLike
  ) => Promise<unknown>;
  setNotificationHandler: (handler: {
    handleNotification: (
      notification: SystemNotificationLike
    ) => Promise<unknown>;
  }) => void;
  addNotificationReceivedListener: (
    listener: (event: SystemNotificationLike) => void
  ) => { remove: () => void };
  addNotificationResponseReceivedListener: (
    listener: (response: NotificationResponseLike) => void
  ) => { remove: () => void };
  getLastNotificationResponseAsync: () => Promise<NotificationResponseLike | null>;
  scheduleNotificationAsync: (
    request: NotificationRequestLike
  ) => Promise<string>;
}

/** 已加载模块缓存（undefined = 尚未探测；null = 探测失败已降级） */
let apiCache: ExpoNotificationsRuntime | null | undefined;

/** 测试注入：强制模拟加载失败（null = 复位为真实加载；见 degraded.test.ts） */
let forceUnavailableForTest: boolean | null = null;

/** 动态加载 expo-notifications（唯一加载点；失败缓存为不可用并告警，不抛给调用方） */
async function loadApi(): Promise<ExpoNotificationsRuntime | null> {
  if (apiCache !== undefined) return apiCache;
  // 测试注入面：等价「Expo Go 加载抛错 → 不可用」的降级契约（真实机制 =
  // 模块求值抛错，见本文件头注；jest 模块工厂抛错会致 worker 退出告警，故用注入）
  if (forceUnavailableForTest === true) {
    apiCache = null;
    return null;
  }
  try {
    apiCache = require('expo-notifications') as ExpoNotificationsRuntime;
    return apiCache;
  } catch (err) {
    apiCache = null;
    console.warn(
      `[notifications] 系统通知面不可用（expo-notifications 加载失败，Expo Go 环境按应用内通知降级）：${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/**
 * 能力探测：expo-notifications 运行时加载成败 → 系统通知面可用性。
 * 结果缓存（同一运行期结论稳定）；Expo Go 下模块求值抛错 → false → 通知层降级。
 */
export async function hasPushModule(): Promise<boolean> {
  return (await loadApi()) !== null;
}

/** 暴露已加载模块（注册/调用面经此取原生 API；不可用 → null） */
export function loadNotificationsApi(): Promise<ExpoNotificationsRuntime | null> {
  return loadApi();
}

/** 测试隔离：复位加载缓存（仅测试调用；下一次探测重新走运行时加载） */
export function resetPushModuleProbeForTest(): void {
  apiCache = undefined;
}

/** 测试隔离：强制模拟系统通知面不可用（true/false 注入；null = 复位真实加载，仅测试调用） */
export function setPushModuleUnavailableForTest(
  unavailable: boolean | null
): void {
  forceUnavailableForTest = unavailable;
  apiCache = undefined;
}

// ── 系统通知 API 安全包装（不可用或调用失败 → 空值/空操作，绝不向调用方抛错） ──

/** 权限查询（降级 → null；refresh 回退未查询态不阻塞启动） */
export async function getPermissionsAsyncSafe(): Promise<PermissionStatusLike | null> {
  const api = await loadApi();
  if (!api) return null;
  try {
    return await api.getPermissionsAsync();
  } catch (err) {
    console.warn('[NotificationsFacade] getPermissionsAsyncSafe failed:', err);
    return null;
  }
}

/** 权限请求（降级 → null；UI 引导层回退未决定态） */
export async function requestPermissionsAsyncSafe(): Promise<PermissionStatusLike | null> {
  const api = await loadApi();
  if (!api) return null;
  try {
    return await api.requestPermissionsAsync();
  } catch (err) {
    console.warn(
      '[NotificationsFacade] requestPermissionsAsyncSafe failed:',
      err
    );
    return null;
  }
}

/** 注册单渠道（降级 → false 跳过；幂等语义由调用方保证） */
export async function setNotificationChannelAsyncSafe(
  channelId: string,
  channel: NotificationChannelInputLike
): Promise<boolean> {
  const api = await loadApi();
  if (!api) return false;
  try {
    await api.setNotificationChannelAsync(channelId, channel);
    return true;
  } catch (err) {
    console.warn(
      `[NotificationsFacade] setNotificationChannelAsyncSafe(${channelId}) failed:`,
      err
    );
    return false;
  }
}

/** 安装前台 handler（降级 → 空操作返回 false） */
export async function setNotificationHandlerSafe(handler: {
  handleNotification: (
    notification: SystemNotificationLike
  ) => Promise<unknown>;
}): Promise<boolean> {
  const api = await loadApi();
  if (!api) return false;
  try {
    api.setNotificationHandler(handler);
    return true;
  } catch (err) {
    console.warn(
      '[NotificationsFacade] setNotificationHandlerSafe failed:',
      err
    );
    return false;
  }
}

/** 订阅系统通知到达（降级 → null；调用方回退空操作退订） */
export async function addNotificationReceivedListenerSafe(
  listener: (event: SystemNotificationLike) => void
): Promise<(() => void) | null> {
  const api = await loadApi();
  if (!api) return null;
  try {
    const sub = api.addNotificationReceivedListener(listener);
    return () => sub.remove();
  } catch (err) {
    console.warn(
      '[NotificationsFacade] addNotificationReceivedListenerSafe failed:',
      err
    );
    return null;
  }
}

/** 订阅通知点击响应（降级 → null；调用方回退空操作退订） */
export async function addNotificationResponseReceivedListenerSafe(
  listener: (response: NotificationResponseLike) => void
): Promise<(() => void) | null> {
  const api = await loadApi();
  if (!api) return null;
  try {
    const sub = api.addNotificationResponseReceivedListener(listener);
    return () => sub.remove();
  } catch (err) {
    console.warn(
      '[NotificationsFacade] addNotificationResponseReceivedListenerSafe failed:',
      err
    );
    return null;
  }
}

/** 冷启动深链补账（降级/失败 → null 静默跳过，不阻塞启动） */
export async function getLastNotificationResponseAsyncSafe(): Promise<NotificationResponseLike | null> {
  const api = await loadApi();
  if (!api) return null;
  try {
    return await api.getLastNotificationResponseAsync();
  } catch (err) {
    console.warn(
      '[NotificationsFacade] getLastNotificationResponseAsyncSafe failed:',
      err
    );
    return null;
  }
}

/** 后台系统通知呈现（降级/失败 → null；presentSystemPushAsync 映射空串标识） */
export async function scheduleNotificationAsyncSafe(
  request: NotificationRequestLike
): Promise<string | null> {
  const api = await loadApi();
  if (!api) return null;
  try {
    return await api.scheduleNotificationAsync(request);
  } catch (err) {
    console.warn(
      '[NotificationsFacade] scheduleNotificationAsyncSafe failed:',
      err
    );
    return null;
  }
}
