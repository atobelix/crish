import {
  loadStoredPermissionMode, permissionModeAfterPlanToggle,
  persistPermissionMode, planModeEnabledFor, type PermissionMode,
} from '../../api/permissionModes';
import {
  addCommandPermission as persistAddCommandPermission,
  loadCommandPermissions, removeCommandPermission as persistRemoveCommandPermission,
  saveCommandPermissions,
} from '../../api/commandPermissions';

export interface PermissionSlice {
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

export type PermissionImmerSet = (recipe: (state: PermissionSlice) => void) => void;
export type PermissionGet = () => PermissionSlice;

const _initialPermissionMode = loadStoredPermissionMode();

export function createInitialPermissionState(): Pick<PermissionSlice, 'permissionMode' | 'planModeEnabled' | 'planApproved' | 'commandPermissions'> {
  return {
    permissionMode: _initialPermissionMode,
    planModeEnabled: planModeEnabledFor(_initialPermissionMode),
    planApproved: false,
    commandPermissions: loadCommandPermissions(),
  };
}

export function createPermissionActions(set: PermissionImmerSet, get: PermissionGet): Pick<PermissionSlice, 'setPermissionMode' | 'setPlanModeEnabled' | 'setPlanApproved' | 'addCommandPermission' | 'removeCommandPermission' | 'setCommandPermissions'> {
  return {
    setPermissionMode: (mode) => {
      set((state) => { state.permissionMode = mode; state.planModeEnabled = planModeEnabledFor(mode); state.planApproved = false; });
      persistPermissionMode(mode);
    },
    setPlanModeEnabled: (enabled) => {
      let nextMode: PermissionMode = 'ask';
      set((state) => {
        nextMode = permissionModeAfterPlanToggle(state.permissionMode, enabled);
        state.permissionMode = nextMode;
        state.planModeEnabled = planModeEnabledFor(nextMode);
        state.planApproved = false;
      });
      persistPermissionMode(nextMode);
    },
    setPlanApproved: (approved) => set((state) => { state.planApproved = approved; }),
    addCommandPermission: (cmd) => set((state) => { state.commandPermissions = persistAddCommandPermission(state.commandPermissions, cmd); }),
    removeCommandPermission: (cmd) => set((state) => { state.commandPermissions = persistRemoveCommandPermission(state.commandPermissions, cmd); }),
    setCommandPermissions: (list) => set((state) => {
      const next = Array.isArray(list) ? list.filter((c) => typeof c === 'string') : [];
      state.commandPermissions = next;
      saveCommandPermissions(next);
    }),
  };
}
