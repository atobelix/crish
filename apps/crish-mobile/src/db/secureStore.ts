// 安全存储封装（M5 §6.1-6.3 / D4 §7.4）：expo-secure-store 接口 + 注入模式
// 划分原则（M5 §6.1）：「泄漏即等于身份/会话失守」的密钥材料 → secure-store（Keychain/Keystore 系统级加密）；
// 「泄漏仅损失隐私/体验」的数据 → SQLite。配对的密码学推导不落任何存储（M5 §6.1 注释）。
// 核心逻辑不直接依赖 expo-secure-store（注入模式）：调用方注入 SecureStoreDriver；
// 唯一接线点为本文件底部 expoSecureStoreDriver 工厂（R-3 已启用真实驱动，
// 依赖 expo-secure-store ~57.0.1）；jest 使用 InMemorySecureStore（仅测试注入）。

/**
 * 密钥位清单（M5 §6.3 KEYS 全量）：
 * - 4 个核心密钥位（任务书 R2-13「4 密钥位」，D4 §7.4 同口径）：
 *   token_key（会话令牌 HMAC 密钥材料）、refresh_key（重连令牌）、设备长期 X25519 密钥对 priv/pub；
 * - 2 个凭证/中间态辅助位：host_fingerprint（桌面自签证书指纹，证书固定用）、
 *   exchange_nonce（配对中间态一次性凭据，配对完成后删除）。
 */
export const KEYS = {
  /** 设备长期 X25519 私钥 Mpriv（base64）——4 密钥位之一 */
  DEVICE_KEYPAIR_PRIV: 'device.keypair.priv',
  /** 设备长期 X25519 公钥 Mpub（配对上报用）——4 密钥位之一 */
  DEVICE_KEYPAIR_PUB: 'device.keypair.pub',
  /** 会话令牌 HMAC 密钥材料（32B base64，D3 §4.4 派生）——4 密钥位之一 */
  PAIR_TOKEN_KEY: 'pair.token_key',
  /** 重连令牌签名密钥（32B base64）——4 密钥位之一 */
  PAIR_REFRESH_KEY: 'pair.refresh_key',
  /** 桌面自签证书指纹（SHA-256 完整值，证书固定，D3 §4.6）——凭证位 */
  HOST_FINGERPRINT: 'pair.host_fingerprint',
  /** 配对中间态一次性交换凭据（短期，配对完成后删除）——中间态位 */
  EXCHANGE_NONCE: 'pair.exchange_nonce',
} as const;

/** 核心密钥位（4 位）：token_key / refresh_key / keypair priv / pub（M5 §6.1） */
export const CORE_KEY_SLOTS: readonly string[] = [
  KEYS.PAIR_TOKEN_KEY,
  KEYS.PAIR_REFRESH_KEY,
  KEYS.DEVICE_KEYPAIR_PRIV,
  KEYS.DEVICE_KEYPAIR_PUB,
];

/** 全部安全键（核心 4 位 + 凭证/中间态 2 位） */
export const ALL_KEY_SLOTS: readonly string[] = [
  ...CORE_KEY_SLOTS,
  KEYS.HOST_FINGERPRINT,
  KEYS.EXCHANGE_NONCE,
];

/**
 * 安全存储驱动接口（对齐 expo-secure-store 的 getItemAsync/setItemAsync/deleteItemAsync）。
 * 注入模式：测试用 InMemorySecureStore；真实环境 expoSecureStoreDriver（见文件底部）。
 */
export interface SecureStoreDriver {
  /** 读值（不存在返回 null） */
  getItem(key: string): Promise<string | null>;
  /** 写值 */
  setItem(key: string, value: string): Promise<void>;
  /** 删值（不存在静默成功，对齐 expo-secure-store 语义） */
  deleteItem(key: string): Promise<void>;
}

/**
 * 内存版安全存储（jest/开发用 mock）：Map 存储，语义对齐 expo-secure-store。
 */
export class InMemorySecureStore implements SecureStoreDriver {
  private readonly store = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async deleteItem(key: string): Promise<void> {
    this.store.delete(key);
  }

  /** 已存键列表（测试自检用） */
  keys(): string[] {
    return [...this.store.keys()];
  }

  /** 清空（测试隔离用） */
  clear(): void {
    this.store.clear();
  }
}

/** 配对凭据（M5 §6.3 PairingCredential） */
export interface PairingCredential {
  /** 会话令牌 HMAC 密钥材料 */
  tokenKey: string;
  /** 重连令牌签名密钥 */
  refreshKey: string;
  /** 设备长期 X25519 私钥 */
  deviceKeypairPriv: string;
  /** 设备长期 X25519 公钥 */
  deviceKeypairPub: string;
  /** 桌面证书指纹（完整值；可空——早期配对可能缺失） */
  hostFingerprint?: string;
}

/**
 * 批量写配对凭据（M5 §6.3 savePairingCredential）。
 * 配对完成前不落库（M5 §6.2：配对成功才写 secure-store）。
 */
export async function savePairingCredential(
  driver: SecureStoreDriver,
  cred: PairingCredential
): Promise<void> {
  await Promise.all([
    driver.setItem(KEYS.PAIR_TOKEN_KEY, cred.tokenKey),
    driver.setItem(KEYS.PAIR_REFRESH_KEY, cred.refreshKey),
    driver.setItem(KEYS.DEVICE_KEYPAIR_PRIV, cred.deviceKeypairPriv),
    driver.setItem(KEYS.DEVICE_KEYPAIR_PUB, cred.deviceKeypairPub),
    ...(cred.hostFingerprint !== undefined
      ? [driver.setItem(KEYS.HOST_FINGERPRINT, cred.hostFingerprint)]
      : []),
  ]);
}

/**
 * 读 + 完整性校验（M5 §6.3 loadPairingCredential）：
 * 任一核心密钥位缺失 → 返回 null（「不部分恢复」，M5 §6.3 注意 4：一律视为未配对，启动走配对引导）。
 */
export async function loadPairingCredential(
  driver: SecureStoreDriver
): Promise<PairingCredential | null> {
  const values = await Promise.all(
    CORE_KEY_SLOTS.map((key) => driver.getItem(key))
  );
  const [tokenKey, refreshKey, deviceKeypairPriv, deviceKeypairPub] = values;
  if (
    tokenKey == null ||
    refreshKey == null ||
    deviceKeypairPriv == null ||
    deviceKeypairPub == null
  ) {
    return null;
  }
  const hostFingerprint = await driver.getItem(KEYS.HOST_FINGERPRINT);
  return {
    tokenKey,
    refreshKey,
    deviceKeypairPriv,
    deviceKeypairPub,
    ...(hostFingerprint !== null ? { hostFingerprint } : {}),
  };
}

/**
 * 清空配对凭据（M5 §6.3 clearPairing / §6.2 移除本机）：
 * 无论桌面撤销是否成功都清空全部 pair.* 与 device.keypair.* 键（含配对中间态 exchange_nonce）。
 */
export async function clearPairing(driver: SecureStoreDriver): Promise<void> {
  await Promise.all(ALL_KEY_SLOTS.map((key) => driver.deleteItem(key)));
}

/** 启动判定（M5 §6.3 hasPairing）：核心 4 密钥位齐备即视为已配对 */
export async function hasPairing(driver: SecureStoreDriver): Promise<boolean> {
  return (await loadPairingCredential(driver)) !== null;
}

/** 写入配对中间态一次性凭据（D3 §4.x 配对流程使用，配对完成后清除） */
export async function saveExchangeNonce(
  driver: SecureStoreDriver,
  nonce: string
): Promise<void> {
  await driver.setItem(KEYS.EXCHANGE_NONCE, nonce);
}

/** 读取配对中间态凭据（不存在返回 null） */
export async function loadExchangeNonce(
  driver: SecureStoreDriver
): Promise<string | null> {
  return driver.getItem(KEYS.EXCHANGE_NONCE);
}

/** 清除配对中间态凭据（配对完成/失败/撤销时调用，M5 §6.2） */
export async function clearExchangeNonce(
  driver: SecureStoreDriver
): Promise<void> {
  await driver.deleteItem(KEYS.EXCHANGE_NONCE);
}

/**
 * 真实环境安全存储驱动（R-3 落地，接线点启用）：映射 expo-secure-store 的
 * getItemAsync/setItemAsync/deleteItemAsync，异常语义透传（读写失败原样抛出，
 * 由调用方按 M5 §6.2 处理）；deleteItem 不存在静默成功（expo-secure-store 语义）。
 *
 * 注意（M5 §6.3 / D4 §7.4）：iOS 单值上限 2048 字节（本方案各值均 ≤64B base64）；
 * Android 需确认 allowBackup=false；开发/生产构建 Keychain 访问组一致（EAS 配置）。
 */
import * as SecureStore from 'expo-secure-store';

export function expoSecureStoreDriver(): SecureStoreDriver {
  return {
    async getItem(key) {
      return SecureStore.getItemAsync(key);
    },
    async setItem(key, value) {
      await SecureStore.setItemAsync(key, value);
    },
    async deleteItem(key) {
      await SecureStore.deleteItemAsync(key);
    },
  };
}
