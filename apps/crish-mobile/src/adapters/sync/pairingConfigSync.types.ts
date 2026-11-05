/**
 * apps/crish-mobile/src/adapters/sync/pairingConfigSync.types.ts
 *
 * 跨端配对态加密配置与搜索 Key 安全同步协议类型契约与错误定义。
 * 规范依据：docs/mobile-web-search-and-sandbox/05-分维-跨端架构对齐与电脑端资产复用方案.md §4.4, §7.4
 */

import type { SecureStoreDriver } from '@/db/secureStore';
import type { localChatStore } from '@/domain/store/localChatStore';
import type { LocalProviderSpec } from '@/domain/types/localChat';

/** 同步解密与验签错误（fail-closed 防御式抛错） */
export class SyncDecryptionError extends Error {
  readonly code = 'SYNC_DECRYPTION_ERROR';
  readonly failClosed = true;

  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'SyncDecryptionError';
  }
}

/** 默认已知搜索提供商清单 */
export const DEFAULT_SEARCH_PROVIDER_IDS: readonly string[] = [
  'tavily',
  'brave',
  'exa',
  'serpapi',
  'bocha',
  'searxng',
  'google_cse',
  'jina',
];

/** 密钥同步请求参数（信封内载荷） */
export interface RequestSecretsSyncParams {
  /** 客户端高熵随机数（防重放与跨会话劫持） */
  readonly clientNonce: string;
  /** 请求同步的作用域列表，如 ['websearch', 'models'] */
  readonly scopes: readonly string[];
}

/** 密钥同步请求完整信封（对齐 WsGateway kind 契约） */
export interface RequestSecretsSyncPayload {
  readonly kind: 'config.request_secrets_sync';
  readonly clientNonce: string;
  readonly scopes: readonly string[];
  readonly body: RequestSecretsSyncParams;
}

/** 桌面端加密响应体契约 */
export interface SecretsSyncResponse {
  /** AES-256-GCM 密文（Base64 编码） */
  readonly cipherText: string;
  /** 初始向量 IV（Base64 编码，通常为 12 字节 / 96-bit） */
  readonly iv: string;
  /** GCM 认证标签 Tag（Base64 编码，16 字节 / 128-bit） */
  readonly tag: string;
  /** 桌面端随机数 */
  readonly serverNonce: string;
  /** 客户端随机数回显（可选，支持信封携带或解密载荷内携带） */
  readonly clientNonce?: string;
  /** 预期客户端随机数（用于防重放检验） */
  readonly expectedClientNonce?: string;
}

/** 响应输入：支持直接传响应体或带 kind/body 的信封 */
export type SecretsSyncResponseInput =
  | SecretsSyncResponse
  | {
      readonly kind?: string;
      readonly body: SecretsSyncResponse;
    };

/** 解密后的同步明文数据结构 */
export interface SyncedSecretsPayload {
  /** 客户端随机数回显（防重放与篡改验证） */
  readonly clientNonce?: string;
  /** 服务端随机数 */
  readonly serverNonce?: string;
  /** 响应时间戳 */
  readonly timestamp?: number;

  /** 搜索供应商 API Key 映射字典（如 { tavily: 'tvly-xxx', brave: 'BSA-xxx' }） */
  readonly webSearchKeys?: Record<string, string>;
  readonly searchKeys?: Record<string, string>;
  readonly websearch?: {
    readonly apiKeys?: Record<string, string>;
    readonly providers?: Record<
      string,
      { readonly apiKey?: string; readonly [key: string]: unknown }
    >;
  };

  /** 模型供应商配置与密钥（可选） */
  readonly models?: {
    readonly providers?: Record<
      string,
      {
        readonly apiKey?: string;
        readonly spec?: Partial<LocalProviderSpec> & {
          readonly name?: string;
        };
        readonly [key: string]: unknown;
      }
    >;
    readonly [key: string]: unknown;
  };
  readonly modelProviders?: Record<
    string,
    {
      readonly apiKey?: string;
      readonly spec?: Partial<LocalProviderSpec> & {
        readonly name?: string;
      };
      readonly [key: string]: unknown;
    }
  >;
}

/** 桌面端加密结果 */
export interface SecretsSyncResult {
  readonly cipherText: string;
  readonly iv: string;
  readonly tag: string;
  readonly serverNonce: string;
  readonly clientNonce?: string;
}

/** 加密可选项 */
export interface EncryptSecretsSyncOptions {
  readonly iv?: Uint8Array | string;
  readonly serverNonce?: string;
  readonly clientNonce?: string;
}

/** 安全存储目标接口（兼容 SecureStoreDriver 与 expo-secure-store 原生面） */
export type SecureStoreTarget =
  | SecureStoreDriver
  | {
      setItemAsync(key: string, value: string): Promise<void>;
      getItemAsync?(key: string): Promise<string | null>;
      deleteItemAsync?(key: string): Promise<void>;
    };

/** 设备落盘应用选项 */
export interface ApplySyncedSecretsOptions {
  readonly secureStore?: SecureStoreTarget;
  readonly chatStore?: typeof localChatStore;
}

/** 设备落盘结果 */
export interface ApplySyncedSecretsResult {
  readonly syncedSearchKeys: readonly string[];
  readonly syncedModelProviders: readonly string[];
}
