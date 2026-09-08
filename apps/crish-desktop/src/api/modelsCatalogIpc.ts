/**
 * modelsCatalogIpc.ts —— Tauri IPC 强类型通信管道与韧性防护
 *
 * 权威对接：
 * - Tauri IPC: models_yaml_read, models_yaml_write, models_yaml_reload
 * - 故障防御：三态分派、单飞复用、自动向后兼容与结构化诊断
 */

import { stringify as yamlStringify } from 'yaml';
import { invokeTyped } from './tauriInvoke';
import type {
  ModelsYamlTree,
  ReadModelsYamlWire,
  ProviderSpec,
  ModelSpec,
} from './modelsCatalogTypes';

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: 'MISSING' | 'IPC_ERROR' | 'PARSE_ERROR'; error: string };

/**
 * 将旧版平铺 CatalogModelSpec[] 转换为 v2.0 树状 ModelsYamlTree
 */
export function convertFlatModelsToTree(flatList: any[]): ModelsYamlTree {
  const providers: Record<string, ProviderSpec> = {};

  for (const item of flatList || []) {
    const rawVendor = String(item.vendor || 'custom').trim().toLowerCase();
    const vendor = rawVendor || 'custom';

    if (!providers[vendor]) {
      providers[vendor] = {
        displayName: item.vendorDisplayName || vendor,
        baseUrl:
          vendor === 'openai'
            ? 'https://api.openai.com/v1'
            : vendor === 'anthropic'
              ? 'https://api.anthropic.com'
              : vendor === 'deepseek'
                ? 'https://api.deepseek.com'
                : 'https://api.openai.com/v1',
        protocol: (item.protocol as any) || 'openai/chat',
        models: [],
      };
    }

    const modelSpec: ModelSpec = {
      id: item.model || item.id,
      displayName: item.displayName || item.model || item.id,
      protocol: item.protocol,
      contextWindow: item.contextWindow,
      maxOutputTokens: item.maxOutputTokens,
      pricing: item.pricing
        ? {
            currency: item.pricing.currency || 'USD',
            unit: 'per_1m_tokens',
            input: item.pricing.inputPerMTok ?? item.pricing.input,
            output: item.pricing.outputPerMTok ?? item.pricing.output,
            cacheRead: item.pricing.cacheReadPerMTok ?? item.pricing.cacheRead,
            cacheWrite: item.pricing.cacheWritePerMTok ?? item.pricing.cacheWrite,
            perImage: item.pricing.perImageCost ?? item.pricing.perImage,
          }
        : undefined,
      capabilities: item.capabilities,
      enabled: true,
    };

    providers[vendor].models.push(modelSpec);
  }

  return {
    version: 2,
    providers,
  };
}

/**
 * 从 Rust 内核读取 models.yaml 真源（自动触发缺失播种）
 * 优先调用 models_yaml_read，缺失时兼容退回 workbench_read_models_yaml
 */
export async function readModelsYamlIpc(): Promise<IpcResult<ReadModelsYamlWire>> {
  // 1. 尝试调用新版 models_yaml_read
  const res = await invokeTyped<ReadModelsYamlWire>('models_yaml_read', {});

  if (res.status === 'ok') {
    if (res.data.parseError) {
      return {
        ok: false,
        kind: 'PARSE_ERROR',
        error: `YAML 第 ${res.data.parseError.line ?? '?'} 行解析失败: ${res.data.parseError.message}`,
      };
    }

    // 若返回已有 tree，直接返回
    if (res.data.tree && res.data.tree.providers) {
      return { ok: true, data: res.data };
    }

    // 若返回的是平铺 models，转换为 tree
    if (res.data.models && Array.isArray(res.data.models)) {
      return {
        ok: true,
        data: {
          ...res.data,
          tree: convertFlatModelsToTree(res.data.models),
        },
      };
    }

    return { ok: true, data: res.data };
  }

  // 2. 若 models_yaml_read 命令未注册，优雅回退至 workbench_read_models_yaml
  if (res.status === 'missing') {
    const fallbackRes = await invokeTyped<any>('workbench_read_models_yaml', {});
    if (fallbackRes.status === 'missing') {
      return { ok: false, kind: 'MISSING', error: 'Tauri 命令 models_yaml_read 未注册' };
    }
    if (fallbackRes.status === 'error') {
      return { ok: false, kind: 'IPC_ERROR', error: fallbackRes.message };
    }

    const wire = fallbackRes.data;
    if (wire.parseError) {
      return {
        ok: false,
        kind: 'PARSE_ERROR',
        error: `models.yaml 解析失败（第 ${wire.parseError.line ?? '?'} 行）：${wire.parseError.message}`,
      };
    }

    const tree = wire.tree || convertFlatModelsToTree(wire.models || []);
    return {
      ok: true,
      data: {
        path: wire.path || '~/.conex/models.yaml',
        content: wire.content,
        rawYaml: wire.content,
        tree,
        models: wire.models,
        seeded: Boolean(wire.seeded),
        parseError: wire.parseError,
      },
    };
  }

  // res.status === 'error'
  return { ok: false, kind: 'IPC_ERROR', error: res.message };
}

/**
 * 将 ModelsYamlTree 规范化并序列化为纯净的 v2 树状 YAML 文本。
 * 彻底铲除手拼 flat models: 列表的降级逻辑，完整保留供应商与模型的全部配置属性与方言。
 */
export function serializeModelsYamlTree(tree: ModelsYamlTree): string {
  const cleanProviders: Record<string, any> = {};

  for (const [vendorId, provider] of Object.entries(tree.providers || {})) {
    // 归一化协议方言：将兼容别名 google/interactions 归一化为标准的 google/generate-content
    const normProviderProtocol =
      provider.protocol === 'google/interactions'
        ? 'google/generate-content'
        : provider.protocol;

    const cleanModels = (provider.models || []).map((m) => {
      const modelProtocol =
        m.protocol === 'google/interactions'
          ? 'google/generate-content'
          : m.protocol;

      const cleanModel: Record<string, any> = {
        id: m.id,
      };

      if (m.displayName) cleanModel.displayName = m.displayName;
      if (modelProtocol) cleanModel.protocol = modelProtocol;
      if (m.contextWindow != null) cleanModel.contextWindow = m.contextWindow;
      else if (m.contextLength != null) cleanModel.contextWindow = m.contextLength;
      if (m.maxOutputTokens != null) cleanModel.maxOutputTokens = m.maxOutputTokens;
      if (m.thinking) cleanModel.thinking = m.thinking;
      if (m.modalities) cleanModel.modalities = m.modalities;
      if (m.capabilities) cleanModel.capabilities = m.capabilities;
      if (m.compat) cleanModel.compat = m.compat;

      if (m.pricing) {
        cleanModel.pricing = {
          currency: m.pricing.currency || 'USD',
          ...(m.pricing.unit ? { unit: m.pricing.unit } : {}),
          ...(m.pricing.input != null
            ? { input: m.pricing.input }
            : m.pricing.inputPerMTok != null
              ? { input: m.pricing.inputPerMTok }
              : {}),
          ...(m.pricing.output != null
            ? { output: m.pricing.output }
            : m.pricing.outputPerMTok != null
              ? { output: m.pricing.outputPerMTok }
              : {}),
          ...(m.pricing.cacheRead != null
            ? { cacheRead: m.pricing.cacheRead }
            : m.pricing.cacheReadPerMTok != null
              ? { cacheRead: m.pricing.cacheReadPerMTok }
              : {}),
          ...(m.pricing.cacheWrite != null
            ? { cacheWrite: m.pricing.cacheWrite }
            : m.pricing.cacheWritePerMTok != null
              ? { cacheWrite: m.pricing.cacheWritePerMTok }
              : {}),
          ...(m.pricing.perImage != null
            ? { perImage: m.pricing.perImage }
            : m.pricing.perImageCost != null
              ? { perImage: m.pricing.perImageCost }
              : {}),
          ...(m.pricing.tiers ? { tiers: m.pricing.tiers } : {}),
        };
      }

      if (m.enabled !== undefined) cleanModel.enabled = m.enabled;

      return cleanModel;
    });

    cleanProviders[vendorId] = {
      displayName: provider.displayName,
      baseUrl: provider.baseUrl,
      protocol: normProviderProtocol,
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
      ...(provider.apiKeyRef ? { apiKeyRef: provider.apiKeyRef } : {}),
      ...(provider.compat ? { compat: provider.compat } : {}),
      ...(provider.headers ? { headers: provider.headers } : {}),
      ...(provider.proxyUrl ? { proxyUrl: provider.proxyUrl } : {}),
      ...(provider.enabled !== undefined ? { enabled: provider.enabled } : {}),
      ...(provider.order !== undefined ? { order: provider.order } : {}),
      models: cleanModels,
    };
  }

  const payload = {
    version: 2,
    providers: cleanProviders,
  };

  return yamlStringify(payload);
}

/**
 * 将整棵模型树原子写入 models.yaml
 * 必须且只写入纯净的 v2 树状结构，若后端报错则向上抛出标准异常供 UI 弹窗，绝不擅自将 v2 降级为残疾 v1！
 */
export async function writeModelsYamlIpc(
  tree: ModelsYamlTree
): Promise<{ ok: boolean; error?: string }> {
  // 1. 优先调用 models_yaml_write（若环境支持，保证测试桩与未来原生树状命令兼容）
  const res = await invokeTyped<{ success: boolean; writtenPath?: string }>('models_yaml_write', {
    tree,
  });

  if (res.status === 'ok') {
    return { ok: true };
  }

  if (res.status === 'error') {
    return { ok: false, error: res.message };
  }

  // 2. 若 models_yaml_write 未注册（生产 Tauri 环境），调用 workbench_save_models_yaml
  // 严格保存纯净 v2 树状结构，彻底铲除手拼平铺列表降级自毁代码！
  const yamlContent = serializeModelsYamlTree(tree);
  const fallbackRes = await invokeTyped<{ path: string; models?: any[] }>(
    'workbench_save_models_yaml',
    { content: yamlContent }
  );

  if (fallbackRes.status === 'ok') {
    return { ok: true };
  }

  return {
    ok: false,
    error:
      fallbackRes.status === 'missing'
        ? 'workbench_save_models_yaml 命令不可用'
        : fallbackRes.message,
  };
}

/**
 * 触发 Rust 内核无锁重载 models.yaml
 */
export async function reloadModelsYamlIpc(): Promise<{ ok: boolean; error?: string }> {
  const res = await invokeTyped<{ reloadedCount?: number }>('models_yaml_reload', {});
  if (res.status === 'ok') {
    return { ok: true };
  }
  return {
    ok: false,
    error: res.status === 'missing' ? 'models_yaml_reload 命令不可用' : res.message,
  };
}

// ── 300ms 智能防抖写入 ────────────────────────────────────────────────────────

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSaveTree: ModelsYamlTree | null = null;
let pendingCallbacks: Array<(ok: boolean, err?: string) => void> = [];

/**
 * 300ms 智能防抖写盘封装
 */
export function debounceSaveModelsYaml(
  tree: ModelsYamlTree,
  onSaveResult?: (ok: boolean, err?: string) => void
): void {
  pendingSaveTree = tree;
  if (onSaveResult) {
    pendingCallbacks.push(onSaveResult);
  }

  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(async () => {
    debounceTimer = null;
    if (!pendingSaveTree) return;

    const target = pendingSaveTree;
    const callbacks = [...pendingCallbacks];
    pendingSaveTree = null;
    pendingCallbacks = [];

    const res = await writeModelsYamlIpc(target);
    for (const cb of callbacks) {
      try {
        cb(res.ok, res.error);
      } catch (err) {
        console.error('[debounceSaveModelsYaml] 回调异常:', err);
      }
    }
  }, 300);
}

/**
 * 启动全系统模型真源热重载监听器
 */
export function setupModelsYamlHotReloadListener(
  onReload: () => Promise<void> | void
): () => void {
  const win = typeof window !== 'undefined' ? (window as any) : null;
  const unlistenPromise = win?.__TAURI__?.event?.listen?.(
    'models-yaml-reloaded',
    async () => {
      console.info('[ModelsCatalog] 收到后端内核热重载广播，自动无缝对齐前端真源...');
      await onReload();
    }
  );

  return () => {
    unlistenPromise?.then((unlisten: any) => typeof unlisten === 'function' && unlisten());
  };
}
