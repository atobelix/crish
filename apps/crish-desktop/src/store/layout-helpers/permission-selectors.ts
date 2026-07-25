import { useShallow } from 'zustand/react/shallow';
import { useLayoutStore } from '../layoutStore';

export function usePermissionMode(): string {
  return useLayoutStore((s) => s.permissionMode);
}

export function usePlanModeEnabled(): boolean {
  return useLayoutStore((s) => s.planModeEnabled);
}

export function usePlanApproved(): boolean {
  return useLayoutStore((s) => s.planApproved);
}

export function useCommandPermissions(): string[] {
  return useLayoutStore(useShallow((s) => s.commandPermissions));
}
