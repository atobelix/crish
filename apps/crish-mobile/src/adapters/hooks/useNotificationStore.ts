// 适配层订阅绑定（通知域，R2-04 部分 5）：领域层 notificationStore → React 组件
// 订阅唯一入口（M4 §2.5 裁决修正 8 同款模式；通知域随 R2-14 第三波独立成文件，
// 避免改 useAppStore.ts 影响并行域）
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import {
  notificationStore,
  type NotificationState,
} from '@/domain/store/notificationStore';

export const useNotificationStore = <T>(
  selector: (s: NotificationState) => T
): T => useStore(notificationStore, useShallow(selector));
