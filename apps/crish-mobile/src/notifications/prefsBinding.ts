// 通知偏好接线（R3-04 部分 3 · R4 批次2 单真源）：设置页开关（settingsStore）→ 通知层过滤
//
// - connectNotificationPrefs：把设置页通知偏好（settingsStore.notification，
//   F6 §4.2 SSOT 持久化）注册为通知层过滤读取器——prefsGate 每次求值时实时读
//   快照（无缓存 → 设置变更即时生效，无需事件总线/订阅；过滤函数见
//   src/notifications/prefsGate.ts）；
// - 语义边界（F6 §10.3 / D7 §6.4-2）：开关只控制「系统通知」面；应用内通知中心
//   （notificationStore ingest）恒保留（双通道去重「应用内保留」语义）；
// - 组装时机：notificationBootstrap（app 启动装配链 ①）调用，先于通知层初始化；
// - 测试隔离：disconnectNotificationPrefs 复位（仅测试调用）。
import { settingsStore } from '@/domain/store/settingsStore';
import {
  bindNotificationPrefs,
  type NotificationPrefs,
} from '@/notifications/prefsGate';

/** settingsStore.notification → 通知层偏好子集（结构投影；实时读取） */
function prefsSnapshot(): NotificationPrefs {
  const group = settingsStore.getState().groups.notification;
  return {
    masterOn: group.masterOn,
    sceneFlags: { ...group.sceneFlags },
  };
}

/** 接线：注册偏好读取器（幂等；重复调用覆盖为同一读取器） */
export function connectNotificationPrefs(): void {
  bindNotificationPrefs(prefsSnapshot);
}

/** 测试隔离：断开接线（过滤回退全放行） */
export function disconnectNotificationPrefs(): void {
  bindNotificationPrefs(null);
}
