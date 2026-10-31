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
 * - 1 个凭证辅助位：host_fingerprint（桌面自签证书指纹，证书固定用）。
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
} as const;

/** 核心密钥位（4 位）：token_key / refresh_key / keypair priv / pub（M5 §6.1） */
export const CORE_KEY_SLOTS: readonly string[] = [
  KEYS.PAIR_TOKEN_KEY,
  KEYS.PAIR_REFRESH_KEY,
  KEYS.DEVICE_KEYPAIR_PRIV,
  KEYS.DEVICE_KEYPAIR_PUB,
];

/** 全部安全键（核心 4 位 + 凭证 1 位） */
export const ALL_KEY_SLOTS: readonly string[] = [
  ...CORE_KEY_SLOTS,
  KEYS.HOST_FINGERPRINT,
];

/** 云端账号会话键（与局域网配对凭据分离；clearPairing 不得清除账号）。 */
export const ACCOUNT_KEYS = {
  ACCESS_TOKEN: 'account.access_token',
  REFRESH_TOKEN: 'account.refresh_token',
  DEVICE_ID: 'account.device_id',
  USER_ID: 'account.user_id',
  EMAIL: 'account.email',
  /** 登录用户完整快照 JSON（冷启动本地秒开：不依赖网络即可恢复登录态） */
  USER_JSON: 'account.user_json',
  /** 账号资料快照 JSON（可空；与 user_json 同生命周期） */
  PROFILE_JSON: 'account.profile_json',
} as const;

export interface AccountSession {
  accessToken: string | null;
  refreshToken: string;
  deviceId: string;
  userId: string | null;
  email: string | null;
  /** 用户快照 JSON（JSON.stringify(AccountUser)；未保存为 null） */
  userJson: string | null;
  /** 资料快照 JSON（JSON.stringify(AccountProfile)；未保存为 null） */
  profileJson: string | null;
}

export async function loadAccountSession(
  driver: SecureStoreDriver
): Promise<AccountSession | null> {
  const [
    refreshToken,
    deviceId,
    accessToken,
    userId,
    email,
    userJson,
    profileJson,
  ] = await Promise.all([
    driver.getItem(ACCOUNT_KEYS.REFRESH_TOKEN),
    driver.getItem(ACCOUNT_KEYS.DEVICE_ID),
    driver.getItem(ACCOUNT_KEYS.ACCESS_TOKEN),
    driver.getItem(ACCOUNT_KEYS.USER_ID),
    driver.getItem(ACCOUNT_KEYS.EMAIL),
    driver.getItem(ACCOUNT_KEYS.USER_JSON),
    driver.getItem(ACCOUNT_KEYS.PROFILE_JSON),
  ]);
  if (refreshToken === null || deviceId === null) return null;
  return {
    accessToken,
    refreshToken,
    deviceId,
    userId,
    email,
    userJson,
    profileJson,
  };
}

export async function saveAccountSession(
  driver: SecureStoreDriver,
  session: AccountSession
): Promise<void> {
  await Promise.all([
    driver.setItem(ACCOUNT_KEYS.REFRESH_TOKEN, session.refreshToken),
    driver.setItem(ACCOUNT_KEYS.DEVICE_ID, session.deviceId),
    session.accessToken !== null
      ? driver.setItem(ACCOUNT_KEYS.ACCESS_TOKEN, session.accessToken)
      : driver.deleteItem(ACCOUNT_KEYS.ACCESS_TOKEN),
    session.userId !== null
      ? driver.setItem(ACCOUNT_KEYS.USER_ID, session.userId)
      : driver.deleteItem(ACCOUNT_KEYS.USER_ID),
    session.email !== null
      ? driver.setItem(ACCOUNT_KEYS.EMAIL, session.email)
      : driver.deleteItem(ACCOUNT_KEYS.EMAIL),
    session.userJson !== null
      ? driver.setItem(ACCOUNT_KEYS.USER_JSON, session.userJson)
      : driver.deleteItem(ACCOUNT_KEYS.USER_JSON),
    session.profileJson !== null
      ? driver.setItem(ACCOUNT_KEYS.PROFILE_JSON, session.profileJson)
      : driver.deleteItem(ACCOUNT_KEYS.PROFILE_JSON),
  ]);
}

export async function clearAccountSession(
  driver: SecureStoreDriver
): Promise<void> {
  await Promise.all(
    Object.values(ACCOUNT_KEYS).map((key) => driver.deleteItem(key))
  );
}

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
 * 无论桌面撤销是否成功都清空全部 pair.* 与 device.keypair.* 键。
 */
export async function clearPairing(driver: SecureStoreDriver): Promise<void> {
  await Promise.all(ALL_KEY_SLOTS.map((key) => driver.deleteItem(key)));
}

/** 启动判定（M5 §6.3 hasPairing）：核心 4 密钥位齐备即视为已配对 */
export async function hasPairing(driver: SecureStoreDriver): Promise<boolean> {
  return (await loadPairingCredential(driver)) !== null;
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
import { Platform } from 'react-native';

/** Web 预览：localStorage 仅作为开发预览存储；原生端始终走系统 Keychain/Keystore。 */
function webStorageDriver(): SecureStoreDriver {
  const prefix = 'crish.secure.';
  const memory = new Map<string, string>();
  const storage =
    typeof globalThis !== 'undefined' &&
    typeof globalThis.localStorage !== 'undefined'
      ? globalThis.localStorage
      : null;
  const read = (key: string): string | null => {
    if (storage) return storage.getItem(`${prefix}${key}`);
    return memory.get(key) ?? null;
  };
  return {
    async getItem(key) {
      return read(key);
    },
    async setItem(key, value) {
      if (storage) storage.setItem(`${prefix}${key}`, value);
      else memory.set(key, value);
    },
    async deleteItem(key) {
      if (storage) storage.removeItem(`${prefix}${key}`);
      else memory.delete(key);
    },
  };
}

export function expoSecureStoreDriver(): SecureStoreDriver {
  if (Platform.OS === 'web') return webStorageDriver();
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
