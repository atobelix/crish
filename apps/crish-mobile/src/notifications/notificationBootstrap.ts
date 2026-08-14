// 通知层启动装配（R3-04 部分 4：生产装配轮——initNotificationLayer 调用点）
// - 装配链（顺序铁律）：① connectNotificationPrefs（设置页开关 → prefsGate 过滤，
//   R3-04 部分 3 接线入口，settingsNotificationWiring.ts:8「启动装配轮调用
//   initNotificationLayer 前执行一次」）→ ② initNotificationLayer（能力探测 →
//   建渠道 → 权限查询 → 前台 handler → 监听 → 冷启动深链，index.ts 顺序铁律）；
// - 配对联动（确认注记）：通知层不依赖配对——桌面只在配对后推送（D7 §6.4
//   「未配对不推」是发送面语义），监听注册无害；推送到达按 authStore 状态处理
//   （pushConsumer 的 PushWiring 已订阅离开 paired → 清呈现去重表，本层无需
//   额外联动）；权限引导（request 弹窗）由 UI 层在配对完成后触发（D7 §7.5），
//   本层只 refresh 不弹窗；
// - 装配时机（调用方约定）：app/_layout 在 SplashGate（auth hydrate）后调用——
//   路由树就绪，冷启动深链导航安全；与 DB 装配无共享依赖（并行 fire-and-forget）；
// - Expo Go 降级（P0-1 DEF-5）：initNotificationLayer 能力探测失败 → 跳过系统面
//   整体装配（应用内通知 only，不抛错不阻塞启动）；本层再兜一层 catch → warn
//   注记降级句柄（装配后 app 仍可启动的契约保证，不向启动链抛错）。
import { connectNotificationPrefs } from '@/adapters/settings/settingsNotificationWiring';
import { initNotificationLayer } from './index';
import type { NotificationLayerHandle } from './index';

/** 通知层装配选项（深链导航注入；缺省不导航仅已读） */
export interface NotificationBootstrapOptions {
  /** 深链导航注入（expo-router router.push 包装；透传 initNotificationLayer） */
  navigate?: (path: string) => void;
}

/**
 * 通知层启动装配（幂等可重复调用；异常 → 降级句柄 + warn 注记，绝不抛给启动链）：
 * 偏好接线 → initNotificationLayer；返回通知层句柄（dispose 解绑监听，卸载/测试用）。
 */
export async function ensureNotificationsForApp(
  options: NotificationBootstrapOptions = {}
): Promise<NotificationLayerHandle> {
  try {
    connectNotificationPrefs();
    return await initNotificationLayer(options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[notifications] 通知层装配失败，降级为应用内通知 only（不阻塞启动）：${message}`
    );
    return {
      permissionStatus: 'undetermined',
      dispose: () => {},
    };
  }
}

export type { NotificationLayerHandle };
