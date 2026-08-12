// 适配层订阅绑定（M4 §2.5 裁决修正 8）：领域层 vanilla store → React 组件
// 订阅的唯一入口；换 UI 框架只重写本文件
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { authStore, type AuthState } from '@/domain/store/authStore';
import {
  approvalStore,
  type ApprovalState,
} from '@/domain/store/approvalStore';
import {
  connectionStore,
  type ConnectionState,
} from '@/domain/store/connectionStore';
import { eventStore, type EventState } from '@/domain/store/eventStore';
import { sessionStore, type SessionState } from '@/domain/store/sessionStore';
import {
  devicePresenceStore,
  type DevicePresenceState,
} from '@/adapters/wiring/devicePresenceStore';

export const useAuthStore = <T>(selector: (s: AuthState) => T): T =>
  useStore(authStore, useShallow(selector));

export const useApprovalStore = <T>(selector: (s: ApprovalState) => T): T =>
  useStore(approvalStore, useShallow(selector));

export const useConnectionStore = <T>(selector: (s: ConnectionState) => T): T =>
  useStore(connectionStore, useShallow(selector));

/** 事件流域订阅（R2-05 观测面：network / windows） */
export const useEventStore = <T>(selector: (s: EventState) => T): T =>
  useStore(eventStore, useShallow(selector));

/** 会话面订阅（R2-05 观测面：sessions / selectedSessionId） */
export const useSessionStore = <T>(selector: (s: SessionState) => T): T =>
  useStore(sessionStore, useShallow(selector));

/** 设备在场订阅（R2-05 状态卡：设备数，null = 未知） */
export const useDevicePresenceStore = <T>(
  selector: (s: DevicePresenceState) => T
): T => useStore(devicePresenceStore, useShallow(selector));
