/**
 * apps/crish-mobile/src/adapters/sync/pairingConfigSync.ts
 *
 * 跨端配对态加密配置与搜索 Key 安全同步协议。
 * 规范依据：docs/mobile-web-search-and-sandbox/05-分维-跨端架构对齐与电脑端资产复用方案.md §4.4, §7.4
 */

import { expoSecureStoreDriver } from '@/db/secureStore';
import { localChatStore } from '@/domain/store/localChatStore';
import { secureRandomBytes } from '@/pairing/crypto/noblePrimitives';
import { sha256Bytes } from '@/network/signer';
import { bytesToBase64, base64ToBytes } from '@/adapters/asr/base64';
import type { LocalProviderSpec } from '@/domain/types/localChat';
import {
  DEFAULT_SEARCH_PROVIDER_IDS,
  SyncDecryptionError,
  type ApplySyncedSecretsOptions,
  type ApplySyncedSecretsResult,
  type EncryptSecretsSyncOptions,
  type RequestSecretsSyncPayload,
  type SecretsSyncResponse,
  type SecretsSyncResponseInput,
  type SecretsSyncResult,
  type SecureStoreTarget,
  type SyncedSecretsPayload,
} from './pairingConfigSync.types';

export * from './pairingConfigSync.types';

/** 生成 128-bit 高熵客户端随机数字符串（32 位 Hex） */
export function generateClientNonce(bytesLength: number = 16): string {
  const bytes = secureRandomBytes(bytesLength);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 构造发起密钥同步请求信令信封 */
export function buildRequestSecretsSyncPayload(
  scopes: readonly string[] = ['websearch', 'models'],
  clientNonce?: string
): RequestSecretsSyncPayload {
  const nonce =
    clientNonce && clientNonce.trim().length > 0
      ? clientNonce.trim()
      : generateClientNonce();
  const safeScopes = scopes.length > 0 ? [...scopes] : ['websearch', 'models'];
  return {
    kind: 'config.request_secrets_sync',
    clientNonce: nonce,
    scopes: safeScopes,
    body: { clientNonce: nonce, scopes: safeScopes },
  };
}

/** 归一化提取 32 字节 AES-256 密钥 */
export function normalizeSessionKey(key: string | Uint8Array): Uint8Array {
  if (key instanceof Uint8Array) {
    return key.length === 32 ? key : sha256Bytes(bytesToBase64(key));
  }
  const t = key.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) {
    const b = new Uint8Array(32);
    for (let i = 0; i < 32; i++)
      b[i] = parseInt(t.substring(i * 2, i * 2 + 2), 16);
    return b;
  }
  try {
    const d = base64ToBytes(t);
    if (d.length === 32) return d;
  } catch {
    // 降级使用 sha256 派生
  }
  return sha256Bytes(t);
}

/** 获取环境 WebCrypto subtle 实例 */
function resolveSubtleCrypto(): SubtleCrypto {
  const cr = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto;
  if (cr?.subtle) return cr.subtle;
  throw new SyncDecryptionError('运行环境缺少 crypto.subtle 加密支持');
}

/** AES-256-GCM 加密核心逻辑 */
async function aesGcmEncrypt(
  keyBytes: Uint8Array,
  ivBytes: Uint8Array,
  plaintextBytes: Uint8Array
): Promise<{ cipherText: Uint8Array; tag: Uint8Array }> {
  const subtle = resolveSubtleCrypto();
  const cryptoKey = await subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
  const encrypted = new Uint8Array(
    await subtle.encrypt(
      { name: 'AES-GCM', iv: ivBytes as BufferSource },
      cryptoKey,
      plaintextBytes as BufferSource
    )
  );
  if (encrypted.length < 16) {
    throw new SyncDecryptionError('AES-GCM 加密输出长度异常（小于 16 字节）');
  }
  return {
    cipherText: encrypted.slice(0, encrypted.length - 16),
    tag: encrypted.slice(encrypted.length - 16),
  };
}

/** AES-256-GCM 解密与认证标签强验签 */
async function aesGcmDecrypt(
  keyBytes: Uint8Array,
  ivBytes: Uint8Array,
  cipherTextBytes: Uint8Array,
  tagBytes: Uint8Array
): Promise<Uint8Array> {
  const subtle = resolveSubtleCrypto();
  const cryptoKey = await subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
  const combined = new Uint8Array(cipherTextBytes.length + tagBytes.length);
  combined.set(cipherTextBytes, 0);
  combined.set(tagBytes, cipherTextBytes.length);

  try {
    const decryptedBuffer = await subtle.decrypt(
      { name: 'AES-GCM', iv: ivBytes as BufferSource },
      cryptoKey,
      combined as BufferSource
    );
    return new Uint8Array(decryptedBuffer);
  } catch (err: unknown) {
    throw new SyncDecryptionError(
      'AES-256-GCM 解密验签失败：认证标签不匹配或密文已被篡改（fail-closed）',
      err
    );
  }
}

/** 桌面端或测试仿真：加密生成响应密文 */
export async function encryptSecretsSyncPayload(
  payload: SyncedSecretsPayload,
  sessionKey: string | Uint8Array,
  options?: EncryptSecretsSyncOptions
): Promise<SecretsSyncResult> {
  const keyBytes = normalizeSessionKey(sessionKey);
  const ivBytes =
    options?.iv instanceof Uint8Array
      ? options.iv
      : typeof options?.iv === 'string'
        ? base64ToBytes(options.iv)
        : secureRandomBytes(12);
  const serverNonce =
    options?.serverNonce && options.serverNonce.trim().length > 0
      ? options.serverNonce.trim()
      : generateClientNonce(16);
  const clientNonce = payload.clientNonce ?? options?.clientNonce ?? undefined;

  const payloadWithMeta: SyncedSecretsPayload = {
    ...payload,
    ...(clientNonce ? { clientNonce } : {}),
    serverNonce,
    timestamp: payload.timestamp ?? Date.now(),
  };

  const plaintextBytes = new TextEncoder().encode(
    JSON.stringify(payloadWithMeta)
  );
  const { cipherText, tag } = await aesGcmEncrypt(
    keyBytes,
    ivBytes,
    plaintextBytes
  );

  return {
    cipherText: bytesToBase64(cipherText),
    iv: bytesToBase64(ivBytes),
    tag: bytesToBase64(tag),
    serverNonce,
    ...(clientNonce ? { clientNonce } : {}),
  };
}

/** 解密并强力验签桌面端返回的密钥同步载荷 */
export async function decryptAndVerifySecretsSyncPayload(
  responseInput: SecretsSyncResponseInput,
  sessionKey: string | Uint8Array,
  expectedClientNonce?: string
): Promise<SyncedSecretsPayload> {
  const response: SecretsSyncResponse =
    'body' in responseInput && typeof responseInput.body === 'object'
      ? responseInput.body
      : (responseInput as SecretsSyncResponse);

  const effectiveExpectedNonce =
    expectedClientNonce?.trim() ?? response.expectedClientNonce?.trim();

  // 1. 信封层防重放随机数校验
  if (
    effectiveExpectedNonce &&
    response.clientNonce &&
    response.clientNonce.trim() !== effectiveExpectedNonce
  ) {
    throw new SyncDecryptionError(
      `防重放校验失败：外层 clientNonce ("${response.clientNonce}") 与请求随机数 ("${effectiveExpectedNonce}") 不一致`
    );
  }

  // 2. 字段完整性校验
  if (!response.cipherText || !response.iv || !response.tag) {
    throw new SyncDecryptionError(
      '密文信封缺失必要参数（cipherText / iv / tag 均为必填项）'
    );
  }

  const keyBytes = normalizeSessionKey(sessionKey);
  let ivBytes: Uint8Array;
  let cipherBytes: Uint8Array;
  let tagBytes: Uint8Array;

  try {
    ivBytes = base64ToBytes(response.iv);
    cipherBytes = base64ToBytes(response.cipherText);
    tagBytes = base64ToBytes(response.tag);
  } catch (err: unknown) {
    throw new SyncDecryptionError(
      'Base64 解码密文参数失败，载荷可能已损坏',
      err
    );
  }

  // 3. 执行 AES-256-GCM 硬件/WebCrypto 密文解密与认证标签强验签
  const decryptedBytes = await aesGcmDecrypt(
    keyBytes,
    ivBytes,
    cipherBytes,
    tagBytes
  );

  let payload: SyncedSecretsPayload;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(decryptedBytes)
    ) as SyncedSecretsPayload;
  } catch (err: unknown) {
    throw new SyncDecryptionError('解密后的明文不是合法的 JSON 格式', err);
  }

  // 4. 内层防重放随机数与篡改比对
  if (
    effectiveExpectedNonce &&
    payload.clientNonce &&
    payload.clientNonce !== effectiveExpectedNonce
  ) {
    throw new SyncDecryptionError(
      `防重放校验失败：内层 clientNonce ("${payload.clientNonce}") 与请求随机数 ("${effectiveExpectedNonce}") 不一致`
    );
  }

  return payload;
}

async function setSecureItem(
  store: SecureStoreTarget,
  key: string,
  value: string
): Promise<void> {
  if ('setItemAsync' in store && typeof store.setItemAsync === 'function') {
    await store.setItemAsync(key, value);
  } else if ('setItem' in store && typeof store.setItem === 'function') {
    await store.setItem(key, value);
  } else {
    throw new Error('不支持的安全存储驱动：缺少 setItem / setItemAsync 接口');
  }
}

async function getSecureItem(
  store: SecureStoreTarget,
  key: string
): Promise<string | null> {
  if ('getItemAsync' in store && typeof store.getItemAsync === 'function')
    return store.getItemAsync(key);
  if ('getItem' in store && typeof store.getItem === 'function')
    return store.getItem(key);
  return null;
}

async function deleteSecureItem(
  store: SecureStoreTarget,
  key: string
): Promise<void> {
  if (
    'deleteItemAsync' in store &&
    typeof store.deleteItemAsync === 'function'
  ) {
    await store.deleteItemAsync(key);
  } else if ('deleteItem' in store && typeof store.deleteItem === 'function') {
    await store.deleteItem(key);
  }
}

/** 提取载荷中的各搜索供应商密钥映射 */
function extractSearchKeys(
  payload: SyncedSecretsPayload
): Record<string, string> {
  const map: Record<string, string> = {};
  const add = (k: string, v?: unknown): void => {
    if (typeof v === 'string' && v.trim())
      map[k.toLowerCase().trim()] = v.trim();
  };
  const record = (src?: Record<string, unknown>): void => {
    if (src) Object.entries(src).forEach(([k, v]) => add(k, v));
  };
  record(payload.webSearchKeys);
  record(payload.searchKeys);
  record(payload.websearch?.apiKeys);
  if (payload.websearch?.providers) {
    Object.entries(payload.websearch.providers).forEach(([id, p]) =>
      add(id, p?.apiKey)
    );
  }
  return map;
}

/** 将解密后的各服务商密钥安全落盘至设备硬件安全存储区 */
export async function applySyncedSecretsToDevice(
  payload: SyncedSecretsPayload,
  options?: ApplySyncedSecretsOptions
): Promise<ApplySyncedSecretsResult> {
  const store = options?.secureStore ?? expoSecureStoreDriver();
  const chatStore = options?.chatStore ?? localChatStore;
  const syncedSearchKeys: string[] = [];
  const syncedModelProviders: string[] = [];

  // 1. 逐项安全落盘搜索供应商 Key 到系统 Keychain/Keystore
  const searchKeysMap = extractSearchKeys(payload);
  for (const [id, secret] of Object.entries(searchKeysMap)) {
    const slotKey = `websearch.provider.${id}.api_key`;
    await setSecureItem(store, slotKey, secret);
    syncedSearchKeys.push(id);
  }

  // 2. 若包含模型配置，安全合并进 localChatStore
  const modelProviders =
    payload.models?.providers ?? payload.modelProviders ?? undefined;
  if (modelProviders && typeof modelProviders === 'object') {
    if (!chatStore.getState().hydrated) {
      await chatStore.getState().hydrate();
    }
    for (const [providerId, entry] of Object.entries(modelProviders)) {
      if (!entry || typeof entry !== 'object') continue;
      const existing = chatStore.getState().config.providers[providerId];
      const mergedSpec: LocalProviderSpec = {
        protocol: entry.spec?.protocol ?? existing?.protocol ?? 'openai/chat',
        models: entry.spec?.models ?? existing?.models ?? [],
        ...(existing ?? {}),
        ...(entry.spec ?? {}),
      };
      const displayName =
        entry.spec?.displayName ?? entry.spec?.name ?? existing?.displayName;
      if (displayName) {
        mergedSpec.displayName = displayName;
      }
      await chatStore
        .getState()
        .upsertProvider(providerId, mergedSpec, entry.apiKey ?? null);
      syncedModelProviders.push(providerId);
    }
  }

  return { syncedSearchKeys, syncedModelProviders };
}

/** 从硬件安全存储安全抹除已同步的搜索密钥 */
export async function clearSyncedSecretsFromDevice(options?: {
  readonly secureStore?: SecureStoreTarget;
  readonly providerIds?: readonly string[];
}): Promise<readonly string[]> {
  const store = options?.secureStore ?? expoSecureStoreDriver();
  const ids = options?.providerIds ?? DEFAULT_SEARCH_PROVIDER_IDS;
  const cleared: string[] = [];

  for (const id of ids) {
    const norm = id.toLowerCase().trim();
    const slotKey = `websearch.provider.${norm}.api_key`;
    await deleteSecureItem(store, slotKey);
    cleared.push(norm);
  }
  return cleared;
}

/** 快速读取某搜索供应商在系统硬件安全区已存的 Key（若无返回 null） */
export async function getSyncedSearchKey(
  providerId: string,
  secureStore?: SecureStoreTarget
): Promise<string | null> {
  const store = secureStore ?? expoSecureStoreDriver();
  const slotKey = `websearch.provider.${providerId.toLowerCase().trim()}.api_key`;
  return getSecureItem(store, slotKey);
}
