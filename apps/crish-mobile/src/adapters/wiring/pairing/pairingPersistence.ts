// 配对接线持久化与元数据定义（pairingWiring 子模块）

import type { AuthPersist } from '@/domain/store/authStore';
import {
  clearPairing,
  loadPairingCredential,
  savePairingCredential,
  type SecureStoreDriver,
} from '@/db/secureStore';

// ── 接线层自管元数据键（secure-store；凭据本身不含身份字段）─────────────────

/** 本机设备 id（signer SignContext.deviceId 冷启动恢复源） */
export const PAIRING_META_DEVICE_ID_KEY = 'pairing.meta.device_id';
/** 桌面 Hub id（pair.ok desktopId，冷启动恢复） */
export const PAIRING_META_DESKTOP_ID_KEY = 'pairing.meta.desktop_id';
/** 桌面连接主机（冷启动恢复端点） */
export const PAIRING_META_HOST_KEY = 'pairing.meta.host';
/** 网关端口（用户自定义端口冷启动恢复源；R4 批次4——此前端口不持久化，
 *  finalizePairing 会话连接硬编码缺省端口，自定义端口配对后连接即失联） */
export const PAIRING_META_PORT_KEY = 'pairing.meta.port';

/** 缺省设备名（pair.hello deviceName 兜底，对齐 pair/manual.tsx 占位） */
export const DEFAULT_DEVICE_NAME = 'crish-mobile';

/** 引擎传输安全开关（R2-16 联调豁免，裁决-1）：`EXPO_PUBLIC_ENGINE_TLS=false`
 *  → 配对期/会话端点解析为明文 ws（联调 harness tls_enabled=false 场景；
 *   RN WebSocket 无自签证书信任选项，R2-16-e2e-plan §3.1 风险 R-1）；
 *  缺省/其它值 → wss（生产装配语义不变）。与 observationWiring 的
 *  EXPO_PUBLIC_ENGINE_URL env 模式对齐（D8 §6.2 优先级 1）。 */
export function engineTlsEnabled(): boolean {
  return process.env.EXPO_PUBLIC_ENGINE_TLS !== 'false';
}

/**
 * secure-store 组装 AuthPersist（authStore 注释「接线层组装」落点）：
 * load = loadPairingCredential；save = savePairingCredential；clear = clearPairing。
 */
export function buildAuthPersist(driver: SecureStoreDriver): AuthPersist {
  return {
    load: () => loadPairingCredential(driver),
    save: (cred) => savePairingCredential(driver, cred),
    clear: () => clearPairing(driver),
  };
}
