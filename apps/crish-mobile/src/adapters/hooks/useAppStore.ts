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
import { modelsStore, type ModelsState } from '@/domain/store/modelsStore';
import { sessionStore, type SessionState } from '@/domain/store/sessionStore';
import {
  deviceSnapshotStore,
  type DeviceSnapshotState,
} from '@/domain/store/deviceSnapshotStore';
import {
  settingsStore,
  type SettingsState,
} from '@/domain/store/settingsStore';
import {
  localChatStore,
  type LocalChatState,
} from '@/domain/store/localChatStore';
import {
  selectEffectiveChatMode,
  type EffectiveChatMode,
} from '@/domain/pure/selectors';

export const useAuthStore = <T>(selector: (s: AuthState) => T): T =>
  useStore(authStore, useShallow(selector));

export const useApprovalStore = <T>(selector: (s: ApprovalState) => T): T =>
  useStore(approvalStore, useShallow(selector));

export const useConnectionStore = <T>(selector: (s: ConnectionState) => T): T =>
  useStore(connectionStore, useShallow(selector));

/**
 * 有效对话模式订阅（CON-2 中央派生：ready → 'remote'，否则 → 'local'）。
 * 屏幕的模式判定只许走本钩子 / selectEffectiveChatMode，禁止再自写
 * phase === 'ready' 谓词（派生本体在 domain/pure/selectors，单一真源）。
 */
export const useEffectiveChatMode = (): EffectiveChatMode =>
  useConnectionStore((s) => selectEffectiveChatMode(s.phase));

/** 事件流域订阅（R2-05 观测面：network / windows） */
export const useEventStore = <T>(selector: (s: EventState) => T): T =>
  useStore(eventStore, useShallow(selector));

/** 会话面订阅（R2-05 观测面：sessions / selectedSessionId） */
export const useSessionStore = <T>(selector: (s: SessionState) => T): T =>
  useStore(sessionStore, useShallow(selector));

/** 远端数据面快照订阅（CON-3：设备分区快照注册表 + live 陈旧标记） */
export const useDeviceSnapshotStore = <T>(
  selector: (s: DeviceSnapshotState) => T
): T => useStore(deviceSnapshotStore, useShallow(selector));

/** 模型面订阅（M2 共享 store：全局默认投影，主页/会话页同一份） */
export const useModelsStore = <T>(selector: (s: ModelsState) => T): T =>
  useStore(modelsStore, useShallow(selector));

/** 设置面订阅（R4 批次2 单真源：appearance/notification 持久化分组） */
export const useSettingsStore = <T>(selector: (s: SettingsState) => T): T =>
  useStore(settingsStore, useShallow(selector));

/** 本地对话配置面订阅（供应商配置/当前选择；密钥不经本面暴露） */
export const useLocalChatStore = <T>(selector: (s: LocalChatState) => T): T =>
  useStore(localChatStore, useShallow(selector));
