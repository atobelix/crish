// 配对接线装配引导（R2-03 部分 3：pair 页面挂载装配点）
// - ensurePairingController：同步确保配对接线单例（幂等；pair 页面消费
//   beginPairing/subscribe/getSnapshot 的统一入口）；
// - 驱动注入（R-3 落地）：默认回退 expoSecureStoreDriver()（真实环境 expo-secure-store
//   持久化，冷启动恢复可用——E2E-4 断线重连/冷启动恢复依赖，R2-16 §3.3）；测试显式
//   注入 InMemorySecureStore 隔离（configurePairingDriver 传 null 复位）；
// - ensurePairingWiringForApp：装配 + 冷启动恢复水合（pair/_layout 挂载调用：
//   已配对 → 恢复 paired → (tabs) AuthGuard 自动放行；未配对 → 走配对引导）；
// - 只读纪律：本文件只消费 pairingWiring 公开 API，不改动接线层。
import {
  ensurePairingWiring,
  getPairingWiring,
  type PairingInput,
  type PairingSnapshot,
  type PairingStartResult,
  type PairingWiring,
} from '@/adapters/wiring/pairing';
import { expoSecureStoreDriver } from '@/db/secureStore';
import type { SecureStoreDriver } from '@/db/secureStore';

/** 应用级安全存储驱动（configurePairingDriver 注入；null = 未注入） */
let appDriver: SecureStoreDriver | null = null;

/**
 * 配对控制器（UI 消费面）：PairingWiring 公开 API 的窄接口——
 * 页面不依赖接线层具体类型，测试注入 fake 即可驱动组件。
 */
export interface PairingController {
  /** 发起配对（本地校验/状态拒绝同步返回；成功进入发送阶段异步收口） */
  beginPairing(input: PairingInput): PairingStartResult;
  /** 冷启动恢复水合（已配对 → 恢复 paired + 直接连接） */
  hydrate(): Promise<boolean>;
  /** 订阅快照变化（返回退订函数） */
  subscribe(listener: () => void): () => void;
  /** 当前快照（机器态 + 最近错误 + 会话相位只读投影） */
  getSnapshot(): PairingSnapshot;
  /** 重置配对流程（清机器态 + 断开配对期连接；放弃在途配对用） */
  reset(): void;
}

/**
 * 安全存储驱动注入点（R-3 落地）：默认已接 expoSecureStoreDriver()（真实环境
 * expo-secure-store 持久化）；configurePairingDriver 用于测试隔离（注入
 * InMemorySecureStore）或特殊装配覆盖。传 null 复位回默认（测试隔离）。
 */
export function configurePairingDriver(driver: SecureStoreDriver | null): void {
  appDriver = driver;
}

/** 同步确保配对接线单例（幂等）：未装配时以当前驱动装配（缺省 expo 真实驱动） */
export function ensurePairingController(): PairingWiring {
  const existing = getPairingWiring();
  if (existing) return existing;
  return ensurePairingWiring({
    driver: appDriver ?? expoSecureStoreDriver(),
  });
}

/** 配对流程页面装配：确保接线单例 + 冷启动恢复水合（幂等；已配对自动恢复） */
export async function ensurePairingWiringForApp(): Promise<PairingWiring> {
  const wiring = ensurePairingController();
  await wiring.hydrate();
  return wiring;
}
