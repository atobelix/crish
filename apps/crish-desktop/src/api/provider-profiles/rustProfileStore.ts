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
import { readModelsYamlIpc, writeModelsYamlIpc } from '../modelsCatalogIpc';
import { modelsCatalogStore } from '../modelsCatalogStore';
import type { ModelsCatalogSnapshot } from '../modelsCatalogTypes';
import type {
  ModelSpec,
  ModelsYamlTree,
  ProviderSpec,
} from '../modelsCatalogTypes';

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
    if (res.data) {
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
    if (res.data) {
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

/**
 * 期 1 特性开关：**已移除**。
 *
 * 原设计「开关置 0 → 回旧命令路径」不成立：旧命令 `config_profile_apply` 已退役
 * （`main.rs` 无注册、`command_manifest.rs` 无条目），回滚到它等于回滚到不可用
 * 路径；而把它改成「显式失败」后开关也没有功能价值。回滚手段 = `git revert`。
 * 移除的另一个原因：模块级可变开关在共享 jsdom 测试环境下会跨文件互扰。
 */

/**
 * 把「活动 profile + model」写进统一树（**纯函数**，可单测）。
 *
 * 语义对齐旧 `config_profile_apply`：把某 profile 置为活动模型。
 * provider / model 不存在则各构造最小项（`ModelSpec.enabled` 必填）；
 * `activeModel` 仅在拿到非空 model 时改写（不臆造选择）。
 */
export function applySelectionToTree(
  tree: ModelsYamlTree,
  args: { profileId: string; baseUrl?: string; model?: string }
): ModelsYamlTree {
  const modelId = (args.model ?? '').trim();
  const existing = tree.providers[args.profileId];
  const models: ModelSpec[] = existing ? [...existing.models] : [];
  if (modelId && !models.some((m) => m.id === modelId)) {
    models.push({ id: modelId, displayName: modelId, enabled: true });
  }
  const provider: ProviderSpec = {
    ...(existing ?? {}),
    displayName: existing?.displayName ?? args.profileId,
    protocol: existing?.protocol ?? 'openai/chat',
    stream: existing?.stream ?? true,
    enabled: existing?.enabled ?? true,
    ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
    models,
  };
  return {
    version: 2,
    activeModel: modelId
      ? { providerId: args.profileId, modelId }
      : (tree.activeModel ?? null),
    providers: { ...tree.providers, [args.profileId]: provider },
  };
}

/**
 * config_profile_apply：把 profile 配置应用到引擎（T07.4-A.3，终态名冻结 F5）——
 * apiKey 落 DPAPI 凭据槽，baseUrl/model 落引擎配置，返回脱敏状态（仅 last4）。
 */
export function configProfileApply(
  args: ConfigProfileApplyArgs
): Promise<InvokeTypedResult<ConfigProfileApplyResult>> {
  const { profileId, ...rest } = args;
  return applyViaUnifiedTree(profileId, rest);
}

/** 空树（首次写入用；对应后端 `content_revision(None)` = `"missing"`）。 */
const EMPTY_TREE: ModelsYamlTree = {
  version: 2,
  activeModel: null,
  providers: {},
};

const APPLY_TREE_MAX_ATTEMPTS = 3;

/**
 * 统一树路径（迁移方案 03 §四期 1）。
 *
 * 旧命令 `config_profile_apply` 已退役（`main.rs` 无注册、`command_manifest.rs`
 * 无条目），调用恒得 `missing` ⇒ 配置迁移 / 切换活动模型 / 密钥激活同步全部失败
 * （实证 2026-09-15）。凭据仍走 `config_secret_set`（DPAPI，明文不出 webview）；
 * 树写入走 `workbench_apply_models_config` 的 CAS，冲突用后端回传的
 * `currentRevision` 重试。fail-closed：任一环失败显式返回。
 */
async function applyViaUnifiedTree(
  profileId: string,
  rest: { apiKey?: string; baseUrl?: string; model?: string }
): Promise<InvokeTypedResult<ConfigProfileApplyResult>> {
  if (rest.apiKey !== undefined) {
    const secret = await configSecretSet(profileId, rest.apiKey);
    if (secret.status === 'missing') return { status: 'missing' };
    if (secret.status === 'error') {
      return {
        status: 'error',
        kind: secret.kind,
        message: secret.message,
        ...(secret.currentRevision
          ? { currentRevision: secret.currentRevision }
          : {}),
      };
    }
  }

  let expectedRevision: string | undefined;
  for (let attempt = 0; attempt < APPLY_TREE_MAX_ATTEMPTS; attempt += 1) {
    const read = await readModelsYamlIpc();
    if (!read.ok) {
      if (read.kind === 'MISSING') return { status: 'missing' };
      return { status: 'error', kind: read.kind, message: read.error };
    }
    const tree = applySelectionToTree(read.data.tree ?? EMPTY_TREE, {
      profileId,
      ...(rest.baseUrl !== undefined ? { baseUrl: rest.baseUrl } : {}),
      ...(rest.model !== undefined ? { model: rest.model } : {}),
    });
    const write = await writeModelsYamlIpc(
      tree,
      expectedRevision ?? read.data.revision
    );
    if (write.ok) {
      const state = write.data.credentialStates?.[profileId];
      return {
        status: 'ok',
        data: {
          ok: true,
          profileId,
          hasApiKey: state?.hasKey === true,
          apiKeyLast4: state?.apiKeyLast4 ?? null,
          ...(rest.model !== undefined ? { model: rest.model } : {}),
          ...(rest.baseUrl !== undefined ? { baseUrl: rest.baseUrl } : {}),
        },
      };
    }
    if (write.kind === 'MISSING') return { status: 'missing' };
    if (write.kind !== 'REVISION_CONFLICT' || !write.currentRevision) {
      return { status: 'error', kind: write.kind, message: write.error };
    }
    expectedRevision = write.currentRevision;
  }
  return {
    status: 'error',
    kind: 'REVISION_CONFLICT',
    message: 'REVISION_CONFLICT：重试次数耗尽',
  };
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
