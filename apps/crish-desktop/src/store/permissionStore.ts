/**
 * permissionStore — 权限域（独立 zustand + immer 实例）。
 *
 * ## Scope（T11 拆分）
 *
 * Owns：
 * - `permissionMode`（ask / plan / auto …）
 * - `planModeEnabled` / `planApproved`（plan 模式三态联动）
 * - `commandPermissions`（命令白名单）
 *
 * ## 持久化
 *
 * 本 store 不接入 zustand persist —— `permissionMode` 与 `commandPermissions`
 * 的落盘继续由既有 `api/permissionModes`（persistPermissionMode /
 * loadStoredPermissionMode）与 `api/commandPermissions`
 * （saveCommandPermissions / loadCommandPermissions）承担，避免双写冲突。
 *
 * @see docs/multi-agent-repair/reports/R3-T11-归类表.md §3
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { withDevtools } from './middleware/withDevtools';
import { withLogger } from './middleware/withLogger';
import {
  loadStoredPermissionMode,
  permissionModeAfterPlanToggle,
  persistPermissionMode,
  planModeEnabledFor,
  type PermissionMode,
} from '../api/permissionModes';
import {
  addCommandPermission as persistAddCommandPermission,
  loadCommandPermissions,
  removeCommandPermission as persistRemoveCommandPermission,
  saveCommandPermissions,
} from '../api/commandPermissions';

export interface PermissionStore {
  permissionMode: PermissionMode;
  planModeEnabled: boolean;
  planApproved: boolean;
  commandPermissions: string[];
  setPermissionMode: (mode: PermissionMode) => void;
  setPlanModeEnabled: (enabled: boolean) => void;
  setPlanApproved: (approved: boolean) => void;
  addCommandPermission: (cmd: string) => void;
  removeCommandPermission: (cmd: string) => void;
  setCommandPermissions: (list: string[]) => void;
}

const initialPermissionMode = loadStoredPermissionMode();

export const usePermissionStore = create<PermissionStore>()(
  withDevtools(
    withLogger(
      immer((set) => ({
        permissionMode: initialPermissionMode,
        // 与设置页 / Composer 共用；hydrate 时 planModeEnabled 必须与 permissionMode 一致
        planModeEnabled: planModeEnabledFor(initialPermissionMode),
        planApproved: false,
        commandPermissions: loadCommandPermissions(),

        setPermissionMode: (mode: PermissionMode) => {
          set((state) => {
            state.permissionMode = mode;
            state.planModeEnabled = planModeEnabledFor(mode);
            state.planApproved = false;
          });
          persistPermissionMode(mode);
        },

        setPlanModeEnabled: (enabled: boolean) => {
          let nextMode: PermissionMode = 'ask';
          set((state) => {
            nextMode = permissionModeAfterPlanToggle(
              state.permissionMode,
              enabled
            );
            state.permissionMode = nextMode;
            state.planModeEnabled = planModeEnabledFor(nextMode);
            state.planApproved = false;
          });
          persistPermissionMode(nextMode);
        },

        setPlanApproved: (approved: boolean) =>
          set((state) => {
            state.planApproved = approved;
          }),

        addCommandPermission: (cmd: string) =>
          set((state) => {
            state.commandPermissions = persistAddCommandPermission(
              state.commandPermissions,
              cmd
            );
          }),

        removeCommandPermission: (cmd: string) =>
          set((state) => {
            state.commandPermissions = persistRemoveCommandPermission(
              state.commandPermissions,
              cmd
            );
          }),

        setCommandPermissions: (list: string[]) =>
          set((state) => {
            const next = Array.isArray(list)
              ? list.filter((c: unknown): c is string => typeof c === 'string')
              : [];
            state.commandPermissions = next;
            saveCommandPermissions(next);
          }),
      }))
    ),
    'PermissionStore'
  )
);
