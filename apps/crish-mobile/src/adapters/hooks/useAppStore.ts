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

export const useAuthStore = <T>(selector: (s: AuthState) => T): T =>
  useStore(authStore, useShallow(selector));

export const useApprovalStore = <T>(selector: (s: ApprovalState) => T): T =>
  useStore(approvalStore, useShallow(selector));

export const useConnectionStore = <T>(selector: (s: ConnectionState) => T): T =>
  useStore(connectionStore, useShallow(selector));
