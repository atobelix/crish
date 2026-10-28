/**
 * 设置 · 多端互通 · 设备改名域 hook（从 SettingsDevicesTab 提取）。
 * 封装改名状态 reducer（renamingHash / renameDraft）与改名处理器。
 */
import { useCallback, useReducer } from 'react';
import { renameDevice, type DeviceInfo } from '../../api/multiDevice';

export interface RenameState {
  renamingHash: string | null;
  renameDraft: string;
}

export type RenameAction =
  | { type: 'startRename'; device: DeviceInfo }
  | { type: 'setRenameDraft'; value: string }
  | { type: 'cancelRename' };

function renameReducer(state: RenameState, action: RenameAction): RenameState {
  switch (action.type) {
    case 'startRename':
      return {
        renamingHash: action.device.id,
        renameDraft: action.device.label,
      };
    case 'setRenameDraft':
      return { ...state, renameDraft: action.value };
    case 'cancelRename':
      return { renamingHash: null, renameDraft: '' };
    default:
      return state;
  }
}

const INITIAL_RENAME: RenameState = {
  renamingHash: null,
  renameDraft: '',
};

export interface UseDeviceRenameArgs {
  mountedRef: React.MutableRefObject<boolean>;
  load: () => Promise<void>;
  showToast: (msg: string) => void;
}

export interface UseDeviceRenameResult {
  rename: RenameState;
  dispatchRename: React.Dispatch<RenameAction>;
  startRename: (device: DeviceInfo) => void;
  handleRename: (hash: string) => Promise<void>;
}

export function useDeviceRename({
  mountedRef,
  load,
  showToast,
}: UseDeviceRenameArgs): UseDeviceRenameResult {
  const [rename, dispatchRename] = useReducer(renameReducer, INITIAL_RENAME);

  const startRename = useCallback((device: DeviceInfo) => {
    dispatchRename({ type: 'startRename', device });
  }, []);

  const handleRename = useCallback(
    async (hash: string) => {
      const label = rename.renameDraft.trim();
      if (!label) {
        showToast('标签不能为空');
        return;
      }
      const ok = await renameDevice(hash, label);
      if (!mountedRef.current) return;
      dispatchRename({ type: 'cancelRename' });
      if (ok) {
        showToast('设备已改名');
      } else {
        showToast('改名失败：设备不存在或已撤销');
      }
      await load();
    },
    [rename.renameDraft, load, showToast, mountedRef]
  );

  return {
    rename,
    dispatchRename,
    startRename,
    handleRename,
  };
}
