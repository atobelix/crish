/**
 * Rust 配置命令唯一薄封装（PE-01 T03.2 规划名，方法名对应 F5 终态表，冻结 v1；
 * PE-07 T07.4 承接实现并新增 config_profile_apply / config_secret_reveal）。
 *
 * 全部方法经 invokeTyped 直调，返回三态 InvokeTypedResult（ok / missing / error）；
 * 调用方（profileStore / migrateLegacyProfiles）按三态显式处理：
 * - missing：非 Tauri 环境 / 命令未注册 → 降级路径由调用方决定；
 * - error：携带 kind（对齐 CoreError variant）+ message。
 *
 * 安全约定（K-01/K-02）：明文 key 只经本模块进出 webview 调用面；
 * 除 configSecretReveal(uiConfirm=true) 外，任何命令返回都不含明文 apiKey。
 */

import { invokeTyped, type InvokeTypedResult } from '../tauriInvoke';

export type ConfigSecretStatus = {
  ok: boolean;
  profileId: string;
  hasKey: boolean;
  /** 掩码：末 4 位（无密钥时为 null） */
  apiKeyLast4?: string | null;
  persistence?: string;
  revealed?: boolean;
};

export type ConfigProfileApplyArgs = {
  profileId: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

export type ConfigProfileApplyResult = {
  ok: boolean;
  profileId: string;
  hasApiKey: boolean;
  apiKeyLast4?: string | null;
  model?: string;
  baseUrl?: string;
  credentialMode?: string;
  credentialPersistence?: string;
};

export type ConfigSecretRevealResult = ConfigSecretStatus & {
  apiKey?: string;
};

/** config_secret_set：写 profile API key 到 DPAPI 凭据槽（空串 = 清除） */
export function configSecretSet(
  profileId: string,
  apiKey: string
): Promise<InvokeTypedResult<ConfigSecretStatus>> {
  return invokeTyped<ConfigSecretStatus>('config_secret_set', {
    profileId,
    apiKey,
  });
}

/** config_secret_get：仅回 { hasKey, apiKeyLast4 }（K-02，不回明文） */
export function configSecretGet(
  profileId: string
): Promise<InvokeTypedResult<ConfigSecretStatus>> {
  return invokeTyped<ConfigSecretStatus>('config_secret_get', { profileId });
}

/** config_secret_has：仅探测是否存在 */
export function configSecretHas(
  profileId: string
): Promise<InvokeTypedResult<ConfigSecretStatus>> {
  return invokeTyped<ConfigSecretStatus>('config_secret_has', { profileId });
}

/** config_secret_clear：清除指定 profile 密钥 */
export function configSecretClear(
  profileId: string
): Promise<InvokeTypedResult<ConfigSecretStatus>> {
  return invokeTyped<ConfigSecretStatus>('config_secret_clear', { profileId });
}

/**
 * config_secret_reveal：「显示密钥」一次性确认入口（K-02）。
 * uiConfirm=true 才回明文（webview 需用户手势确认后再调用）；false 仅回 last4。
 */
export function configSecretReveal(
  profileId: string,
  uiConfirm: boolean
): Promise<InvokeTypedResult<ConfigSecretRevealResult>> {
  return invokeTyped<ConfigSecretRevealResult>('config_secret_reveal', {
    profileId,
    uiConfirm,
  });
}

/**
 * config_profile_apply：把 profile 配置应用到引擎（T07.4-A.3，终态名冻结 F5）——
 * apiKey 落 DPAPI 凭据槽，baseUrl/model 落引擎配置，返回脱敏状态（仅 last4）。
 */
export function configProfileApply(
  args: ConfigProfileApplyArgs
): Promise<InvokeTypedResult<ConfigProfileApplyResult>> {
  const { profileId, ...rest } = args;
  return invokeTyped<ConfigProfileApplyResult>('config_profile_apply', {
    profileId,
    ...(rest.apiKey !== undefined ? { apiKey: rest.apiKey } : {}),
    ...(rest.baseUrl !== undefined ? { baseUrl: rest.baseUrl } : {}),
    ...(rest.model !== undefined ? { model: rest.model } : {}),
  });
}

export type ProbePingResult = {
  ok: boolean;
  latencyMs: number;
  statusCode?: number;
  error?: string;
};

export type ScannedModel = {
  model: string;
  vendor?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: {
    tools?: boolean;
    vision?: boolean;
    reasoning?: boolean;
  };
};

export type ProbeScanResult = {
  ok: boolean;
  models: ScannedModel[];
  error?: string;
};

/**
 * provider_probe_ping：原生服务商连通性探活（底层从 DPAPI 读 Key，高精度 RTT 测速）
 */
export function providerProbePing(
  profileId: string,
  model?: string,
  timeoutMs?: number
): Promise<InvokeTypedResult<ProbePingResult>> {
  return invokeTyped<ProbePingResult>('provider_probe_ping', {
    profileId,
    ...(model ? { model } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

/**
 * provider_probe_scan_models：原生模型列表扫描（底层从 DPAPI 读 Key 请求 /models 并自动合并 Catalog）
 */
export function providerProbeScanModels(
  profileId: string,
  timeoutMs?: number
): Promise<InvokeTypedResult<ProbeScanResult>> {
  return invokeTyped<ProbeScanResult>('provider_probe_scan_models', {
    profileId,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}
