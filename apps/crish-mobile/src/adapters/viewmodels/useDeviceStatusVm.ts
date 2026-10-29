// 设备连接状态视图模型：新对话头栏胶囊、会话页副行与断线条共用。
import { useCallback } from 'react';
import { useAuthStore, useConnectionStore } from '@/adapters/hooks/useAppStore';
import { selectConnectionPhaseText } from '@/domain/store/connectionStore';
import {
  ensureObservationWiring,
  getObservationWiring,
} from '@/adapters/wiring/observationWiring';

export interface DeviceStatusVm {
  connected: boolean;
  phaseLabel: string;
  host: string | null;
  lastError: string | null;
  reconnect: () => void;
}

export function useDeviceStatusVm(): DeviceStatusVm {
  const phase = useConnectionStore((s) => s.phase);
  const lastError = useConnectionStore((s) => s.lastError);
  const host = useAuthStore((s) => s.host);

  const reconnect = useCallback(() => {
    const wiring = getObservationWiring();
    if (wiring) wiring.reconnect();
    else ensureObservationWiring();
  }, []);

  return {
    connected: phase === 'ready',
    phaseLabel: selectConnectionPhaseText(phase),
    host,
    lastError,
    reconnect,
  };
}

/** 一行设备描述：在线显示主机名，离线显示连接阶段 */
export function deviceLineOf(
  vm: Pick<DeviceStatusVm, 'connected' | 'phaseLabel' | 'host'>
): string {
  if (!vm.connected) return vm.phaseLabel;
  return vm.host ? `电脑在线 · ${vm.host}` : '电脑在线';
}
