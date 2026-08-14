// 配对接线单例装配与测试隔离（pairingWiring 子模块）

import { configureAuthPersistence } from '@/domain/store/authStore';
import { PairingWiring, type PairingWiringOptions } from './PairingWiring';

let singleton: PairingWiring | null = null;

/** 装配配对接线（注入点全可测；driver 必填） */
export function startPairingWiring(opts: PairingWiringOptions): PairingWiring {
  return new PairingWiring(opts);
}

/**
 * 配对接线单例（应用启动时调用；幂等）。装配时注入 authStore 默认持久化
 * （configureAuthPersistence：应用侧 authStore.hydrate() 无参调用即可恢复配对态）
 * 并触发冷启动恢复（fire-and-forget，已配对 → 直接连接）。
 */
export function ensurePairingWiring(opts: PairingWiringOptions): PairingWiring {
  if (singleton) return singleton;
  singleton = startPairingWiring(opts);
  singleton.configure();
  void singleton.hydrate();
  return singleton;
}

/** 当前接线单例读取（测试/诊断；未装配返回 null） */
export function getPairingWiring(): PairingWiring | null {
  return singleton;
}

/** 测试隔离：清空配对接线单例（仅测试调用；authStore 默认持久化一并复位） */
export function resetPairingWiringForTest(): void {
  singleton?.dispose();
  singleton = null;
  configureAuthPersistence(null);
}
