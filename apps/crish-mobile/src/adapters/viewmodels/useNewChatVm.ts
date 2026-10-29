// 新对话页视图模型：设备连接状态 + 未读通知数。
import { useNotificationStore } from '@/adapters/hooks/useNotificationStore';
import { useDeviceStatusVm, type DeviceStatusVm } from './useDeviceStatusVm';

export interface NewChatVm extends DeviceStatusVm {
  unreadNotifications: number;
}

export function useNewChatVm(): NewChatVm {
  const device = useDeviceStatusVm();
  const unreadNotifications = useNotificationStore((s) => s.unreadCount);
  return { ...device, unreadNotifications };
}
