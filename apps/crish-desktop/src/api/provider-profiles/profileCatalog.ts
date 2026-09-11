/**
 * 默认服务商配置模板与预置目录类型与常量。
 */

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
  /** 供应商首要通信协议（Default Protocol，下属模型默认继承） */
  protocol?: 'openai/chat' | 'openai/responses' | 'anthropic/messages' | undefined;
  authType?: AuthType | undefined;
  models: string[];
  /** 是否已保存密钥或已完成 OAuth 授权 */
  hasKey: boolean;
  /**
   * @deprecated legacy 明文字段（PE-07 T07.4 / K-01）：明文 key 下线后
   * 规范化输出不再携带本字段（normalizeProviderProfile 剥离并丢弃）；
   * 明文只存 DPAPI 凭据槽（config_secret_set / config_profile_apply）。
   * 本字段仅用于读取旧数据 / hasKey 判定 / 一次性迁移。
   * @see config_secret_set / config_profile_apply（DPAPI 凭据槽）
   */
  apiKey?: string | undefined;
  oauthConfig?: OAuthConfig | undefined;
  oauthToken?: OAuthTokenData | undefined;
  subscriptionPlan?: 'free' | 'go' | 'zen' | 'copilot_pro' | 'custom' | undefined;
  enabled?: boolean | undefined;
};

export type FlatModelChoice = {
  profileId: string;
  profileName: string;
  model: string;
  hasKey: boolean;
};

export type ResolvedModelSelection = {
  profileId: string;
  model: string;
  source:
    | 'stored_active'
    | 'stored_model_match'
    | 'active_profile_first'
    | 'first_available'
    | 'engine_match';
};

export type PickDefaultModelOptions = {
  storedProfileId?: string | null | undefined;
  storedModel?: string | null | undefined;
  engineModel?: string | null | undefined;
  /** 为 true 时要求 model 必须在 profile.models 中 */
  requireInList?: boolean | undefined;
};

/**
 * 首次空库种子：**空列表**。
 * 产品中立——不预置任何第三方服务商壳；用户在向导或设置中自填
 * 名称 / Base URL / 密钥 / 协议。协议层只做 openai|anthropic 兼容。
 */
export const DEFAULT_PROFILES: ProviderProfile[] = [];

/** 导出只读默认壳，便于单测断言契约（恒为 []） */
export function getDefaultProviderProfiles(): ProviderProfile[] {
  return DEFAULT_PROFILES.map((p) => ({ ...p, models: [...p.models] }));
}

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

/** 所有旧种子/演示 model id（跨壳扁平；用于幽灵 active 与 pick 守卫） */
export const LEGACY_SEED_MODEL_ID_SET: ReadonlySet<string> = new Set(
  Object.values(LEGACY_SEED_MODELS).flatMap((ids) => [...ids])
);
