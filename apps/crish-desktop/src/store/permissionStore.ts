/**
 * permissionStore — 权限核心状态域（独立 zustand + immer 实例）。
 *
 * 架构重构纪律：
 * 1. 单一状态：仅维护 permissionMode（'ask' | 'smart' | 'full'），杜绝状态爆炸；
 * 2. 彻底解耦：Plan 模式与命令白名单已全部物理剥离，零派生监听与跨域副作用；
 * 3. 极简持久化：单向同步写入 LocalStorage（crish_permission_mode），避开双写。
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { withDevtools } from './middleware/withDevtools';
import { withLogger } from './middleware/withLogger';
import {
  loadStoredPermissionMode,
  persistPermissionMode,
  type PermissionMode,
} from '../api/permissionModes';

export interface PermissionStore {
  /** 当前权限模式（严格收敛为三选项：ask | smart | full） */
  permissionMode: PermissionMode;
  /** 设置权限模式并触发持久化落盘 */
  setPermissionMode: (mode: PermissionMode) => void;
}

export const usePermissionStore = create<PermissionStore>()(
  withDevtools(
    withLogger(
      immer((set) => ({
        permissionMode: loadStoredPermissionMode(),

        setPermissionMode: (mode: PermissionMode) => {
          set((state) => {
            state.permissionMode = mode;
          });
          persistPermissionMode(mode);
        },
      }))
    ),
    'PermissionStore'
  )
);
