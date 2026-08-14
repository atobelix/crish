// 通知偏好接线（R3-04 部分 3）：设置页开关（settingsLocalStore）→ 通知层过滤
//
// - connectNotificationPrefs：把设置页本机偏好（审批/事件开关）注册为通知层
//   过滤读取器——prefsGate 每次求值时实时读快照（无缓存 → 设置变更即时生效，
//   无需事件总线/订阅；过滤函数见 src/notifications/prefsGate.ts）；
// - 语义边界（F6 §10.3 / D7 §6.4-2）：开关只控制「系统通知」面；应用内通知中心
//   （notificationStore ingest）恒保留（双通道去重「应用内保留」语义）；
// - 组装时机：app 启动装配轮调用 initNotificationLayer 前执行一次
//   （本函数幂等可重复调用；当前无独立装配文件，入口保留给启动装配轮）；
// - 测试隔离：disconnectNotificationPrefs 复位（仅测试调用）。
import { settingsLocalStore } from './settingsLocalStore';
import {
  bindNotificationPrefs,
  type NotificationPrefs,
} from '@/notifications/prefsGate';

/** 本机偏好 → 通知层偏好子集（结构镜像；实时读取） */
function prefsSnapshot(): NotificationPrefs {
  const prefs = settingsLocalStore.getState().prefs;
  return {
    approvalNotifications: prefs.approvalNotifications,
    eventNotifications: prefs.eventNotifications,
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
