/**
 * 设置 · 多端互通 · 配对域 hook（从 SettingsDevicesTab 提取）。
 * 封装配对状态 reducer（status / pairResult / busy / confirmClosePairing /
 * serviceEnabled）与配对/服务开关/复制码处理器；组件仅渲染。
 */
import { useCallback, useReducer } from 'react';
import {
  pairStart,
  pairCancel,
  setMultiDeviceEnabled,
  type PairStartResult,
  type PairStatus,
} from '../../api/multiDevice';

export interface PairingState {
  status: PairStatus | null;
  pairResult: PairStartResult | null;
  busy: boolean;
  confirmClosePairing: boolean;
  serviceEnabled: boolean;
}

export type PairingAction =
  | { type: 'setStatus'; status: PairStatus | null }
  | { type: 'setPairResult'; pairResult: PairStartResult | null }
  | { type: 'setBusy'; busy: boolean }
  | { type: 'setConfirmClosePairing'; open: boolean }
  | { type: 'setServiceEnabled'; enabled: boolean }
  | { type: 'clearPairing' };

function pairingReducer(
  state: PairingState,
  action: PairingAction
): PairingState {
  switch (action.type) {
    case 'setStatus':
      // 服务开关真值随状态快照同步：切页/重挂载后由后端恢复，
      // 不再依赖组件生命周期内的本地记忆。
      // ?? 兜底：前端 HMR 可能先于 Rust 重编译生效（旧二进制无该字段），
      // 此时保留本地开关记忆，避免开发期把运行中的服务显示成关闭。
      return {
        ...state,
        status: action.status,
        serviceEnabled: action.status?.service_enabled ?? state.serviceEnabled,
      };
    case 'setPairResult':
      return { ...state, pairResult: action.pairResult };
    case 'setBusy':
      return { ...state, busy: action.busy };
    case 'setConfirmClosePairing':
      return { ...state, confirmClosePairing: action.open };
    case 'setServiceEnabled':
      return { ...state, serviceEnabled: action.enabled };
    case 'clearPairing':
      return { ...state, pairResult: null, confirmClosePairing: false };
    default:
      return state;
  }
}

const INITIAL_PAIRING: PairingState = {
  status: null,
  pairResult: null,
  busy: false,
  confirmClosePairing: false,
  // 首帧（尚未拿到 pair_status）按关闭态渲染；首次轮询即由后端真值覆盖。
  serviceEnabled: false,
};

export interface UseDevicePairingArgs {
  mountedRef: React.MutableRefObject<boolean>;
  load: () => Promise<void>;
  showToast: (msg: string) => void;
}

export interface UseDevicePairingResult {
  pairing: PairingState;
  dispatchPairing: React.Dispatch<PairingAction>;
  handleToggle: (on: boolean) => Promise<void>;
  handleEnableService: () => Promise<void>;
  handleDisableService: () => Promise<void>;
  handleCopyCode: () => Promise<void>;
}

export function useDevicePairing({
  mountedRef,
  load,
  showToast,
}: UseDevicePairingArgs): UseDevicePairingResult {
  const [pairing, dispatchPairing] = useReducer(
    pairingReducer,
    INITIAL_PAIRING
  );

  const handleToggle = useCallback(
    async (on: boolean) => {
      if (pairing.busy) return;
      dispatchPairing({ type: 'setBusy', busy: true });
      try {
        if (on) {
          const result = await pairStart();
          if (!mountedRef.current) return;
          if (result) {
            dispatchPairing({ type: 'setPairResult', pairResult: result });
            showToast('配对已开启：可用手机扫码');
          } else {
            showToast('开启配对失败（命令不可用或引擎未就绪）');
          }
        } else {
          await pairCancel();
          if (!mountedRef.current) return;
          dispatchPairing({ type: 'setPairResult', pairResult: null });
          showToast('配对已关闭');
        }
        await load();
      } finally {
        if (mountedRef.current)
          dispatchPairing({ type: 'setBusy', busy: false });
      }
    },
    [pairing.busy, load, showToast, mountedRef]
  );

  // 服务开关（R1-11）：开启 → 本机开始监听，随后才显示配对模式开关；
  // 关闭 → 停服（零监听），已配对设备立即断开（令牌保留，重新开启服务后
  // 可直接重连，无需重新配对）。
  const handleEnableService = useCallback(async () => {
    if (pairing.busy) return;
    dispatchPairing({ type: 'setBusy', busy: true });
    try {
      const ok = await setMultiDeviceEnabled(true);
      if (!mountedRef.current) return;
      if (ok) {
        dispatchPairing({ type: 'setServiceEnabled', enabled: true });
        showToast('多端服务已开启：本机可被手机连接');
      } else {
        showToast('开启服务失败（命令不可用或引擎未就绪）');
      }
      await load();
    } finally {
      if (mountedRef.current) dispatchPairing({ type: 'setBusy', busy: false });
    }
  }, [pairing.busy, load, showToast, mountedRef]);

  const handleDisableService = useCallback(async () => {
    if (pairing.busy) return;
    dispatchPairing({ type: 'setBusy', busy: true });
    try {
      const ok = await setMultiDeviceEnabled(false);
      if (!mountedRef.current) return;
      if (ok) {
        dispatchPairing({ type: 'setServiceEnabled', enabled: false });
        dispatchPairing({ type: 'clearPairing' });
        showToast('服务已关闭：已断开所有已配对设备');
      } else {
        showToast('关闭服务失败（命令不可用或引擎未就绪）');
      }
      await load();
    } finally {
      if (mountedRef.current) dispatchPairing({ type: 'setBusy', busy: false });
    }
  }, [pairing.busy, load, showToast, mountedRef]);

  const handleCopyCode = useCallback(async () => {
    if (!pairing.pairResult) return;
    try {
      await navigator.clipboard.writeText(pairing.pairResult.code);
      showToast('配对码已复制');
    } catch {
      showToast('复制失败');
    }
  }, [pairing.pairResult, showToast]);

  return {
    pairing,
    dispatchPairing,
    handleToggle,
    handleEnableService,
    handleDisableService,
    handleCopyCode,
  };
}
