/**
 * Rust 凭据与探测命令唯一薄封装。
 *
 * 全部方法经 invokeTyped 直调，返回三态 InvokeTypedResult（ok / missing / error）；
 * 调用方按三态显式处理：missing（非 Tauri 环境 / 命令未注册）→ 由调用方决定降级。
 *
 * 安全约定（K-01/K-02）：明文 key 只经本模块进出 webview 调用面；
 * 除 configSecretReveal(uiConfirm=true) 外，任何命令返回都不含明文 apiKey。
 * 凭据写入（set/clear）回执携带完整树快照 → 立即安装进 modelsCatalogStore，
 * 保证镜像 revision 与盘上恒等（无第二份真源）。
 */

import { invokeTyped, type InvokeTypedResult } from '../tauriInvoke';
import { modelsCatalogStore } from '../modelsCatalogStore';
import type { ModelsCatalogSnapshot } from '../modelsCatalogTypes';

export type ConfigSecretStatus = {
  ok: boolean;
  profileId: string;
  hasKey: boolean;
  /** 掩码：末 4 位（无密钥时为 null） */
  apiKeyLast4?: string | null;
  persistence?: string;
  revealed?: boolean;
};

export type ConfigSecretRevealResult = ConfigSecretStatus & {
  apiKey?: string;
};

/** config_secret_set：写 profile API key 到 DPAPI 凭据槽（空串 = 清除） */
export async function configSecretSet(
  providerId: string,
  apiKey: string,
  expectedRevision?: string
): Promise<InvokeTypedResult<ConfigSecretStatus>> {
  const rev = expectedRevision ?? modelsCatalogStore.getState().revision ?? '';
  const res = await invokeTyped<ModelsCatalogSnapshot>('config_secret_set', {
    providerId,
    apiKey,
    expectedRevision: rev,
  });
  if (res.status === 'ok') {
    if (res.data?.tree) {
      modelsCatalogStore.acceptSnapshot(res.data);
    }
    const cred = res.data?.credentialStates?.[providerId];
    return {
      status: 'ok',
      data: {
        ok: true,
        profileId: providerId,
        hasKey: cred?.hasKey ?? Boolean(apiKey.trim()),
        apiKeyLast4: cred?.apiKeyLast4,
      },
    };
  }
  return res as unknown as InvokeTypedResult<ConfigSecretStatus>;
}

/** config_secret_get：仅回 { hasKey, apiKeyLast4 }（K-02，不回明文） */
export function configSecretGet(
  providerId: string
): Promise<InvokeTypedResult<ConfigSecretStatus>> {
  return invokeTyped<ConfigSecretStatus>('config_secret_get', { providerId });
}

/** config_secret_has：仅探测是否存在 */
export function configSecretHas(
  providerId: string
): Promise<InvokeTypedResult<ConfigSecretStatus>> {
  return invokeTyped<ConfigSecretStatus>('config_secret_has', { providerId });
}

/** config_secret_clear：清除指定 profile 密钥 */
export async function configSecretClear(
  providerId: string,
  expectedRevision?: string
): Promise<InvokeTypedResult<ConfigSecretStatus>> {
  const rev = expectedRevision ?? modelsCatalogStore.getState().revision ?? '';
  const res = await invokeTyped<ModelsCatalogSnapshot>('config_secret_clear', {
    providerId,
    expectedRevision: rev,
  });
  if (res.status === 'ok') {
    if (res.data?.tree) {
      modelsCatalogStore.acceptSnapshot(res.data);
    }
    return {
      status: 'ok',
      data: {
        ok: true,
        profileId: providerId,
        hasKey: false,
      },
    };
  }
  return res as unknown as InvokeTypedResult<ConfigSecretStatus>;
}

/**
 * config_secret_reveal：「显示密钥」一次性确认入口（K-02）。
 * uiConfirm=true 才回明文（webview 需用户手势确认后再调用）；false 仅回 last4。
 */
export function configSecretReveal(
  providerId: string,
  uiConfirm: boolean
): Promise<InvokeTypedResult<ConfigSecretRevealResult>> {
  return invokeTyped<ConfigSecretRevealResult>('config_secret_reveal', {
    providerId,
    uiConfirm,
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
