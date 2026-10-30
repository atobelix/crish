/**
 * OAuth 档案轨类型与展示常量。
 *
 * 单轨口径：统一树（modelsCatalogStore）承载供应商/模型目录；本文件类型只
 * 描述 LS 档案记录（OAuth/订阅身份）与它的 UI 投影（见 modelsCatalogLive
 * 的 toProviderView）。旧种子数据结构保留给一次性剥离逻辑
 * （profileValidation.stripLegacySeedModels）。
 */

import type { ModelProtocol } from '../modelsNormalize';

export type AuthType = 'api_key' | 'oauth2' | 'subscription';

export type OAuthTokenData = {
  accessToken: string;
  refreshToken?: string;
  /** Unix 时间戳 (ms)，指示 access token 何时过期 */
  expiresAt: number;
  tokenType?: string;
  scope?: string;
  idToken?: string;
  issuedAt?: number;
};

export type OAuthConfig = {
  clientId: string;
  clientSecret?: string;
  authorizeUrl?: string;
  tokenUrl: string;
  refreshUrl?: string;
  scopes?: string[];
  redirectUri?: string;
  resource?: string;
};

export type ProviderProfile = {
  id: string;
  name: string;
  baseUrl: string;
  /** 供应商首要通信协议（Default Protocol，下属模型默认继承）；枚举 SSOT 见 modelsNormalize */
  protocol?: ModelProtocol | undefined;
  authType?: AuthType | undefined;
  models: string[];
  /** 是否已保存密钥或已完成 OAuth 授权 */
  hasKey: boolean;
  /**
   * @deprecated legacy 明文字段（PE-07 T07.4 / K-01）：明文 key 下线后
   * 规范化输出不再携带本字段（normalizeProviderProfile 剥离并丢弃）；
   * 明文只存 DPAPI 凭据槽（config_secret_set）。
   * 本字段仅用于读取旧数据 / hasKey 判定 / 一次性迁移。
   * @see config_secret_set（DPAPI 凭据槽）
   * @removeWhen migrateLegacyProfiles 迁移完成标记全量覆盖后
   */
  apiKey?: string | undefined;
  oauthConfig?: OAuthConfig | undefined;
  oauthToken?: OAuthTokenData | undefined;
  subscriptionPlan?:
    'free' | 'go' | 'zen' | 'copilot_pro' | 'custom' | undefined;
  enabled?: boolean | undefined;
};

/**
 * 历史壳 id → 中文/产品展示名（仅兼容存量用户 LS 数据；不再种子化）。
 * 新建 profile 一律 custom-*，展示名取 name 字段。
 */
export const KNOWN_PROFILE_LABELS: Readonly<Record<string, string>> = {
  'opencode-go': 'OpenCode Go 订阅',
  'opencode-zen': 'OpenCode Zen 订阅',
  deepseek: 'DeepSeek 官方',
  qwen: '千问 Qwen Portal',
  openai: 'OpenAI 兼容',
  /** 需 OpenAI 兼容代理；原生 Anthropic Messages API 未接线 */
  anthropic: 'Anthropic（OpenAI 兼容代理）',
  flowbit: 'Flowbit',
};

export const UNNAMED_PROFILE_LABEL = '未命名服务商';

/**
 * 旧版 DEFAULT_PROFILES 曾硬编码的演示/示例模型。
 * 无密钥且 models 集合与旧种子完全一致时，load 时剥离（本地优先，去 mimo 污染）。
 * 用户已配密钥或自行改过列表则不动。
 */
export const LEGACY_SEED_MODELS: Readonly<Record<string, readonly string[]>> = {
  flowbit: ['mimo-v2.5'],
  openai: ['gpt-4o', 'gpt-4o-mini'],
  deepseek: ['deepseek-chat', 'deepseek-v4-flash'],
  anthropic: ['claude-sonnet-4-5', 'claude-opus-4'],
};
