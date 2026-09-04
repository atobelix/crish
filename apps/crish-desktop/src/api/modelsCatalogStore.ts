/**
 * modelsCatalogStore.ts —— 模型字典前端镜像
 *
 * 权属裁决（SSOT）：
 * - 磁盘 YAML（~/.conex/models.yaml）是模型字典的绝对唯一真源，解析只在 Rust
 *   （serde_yaml）发生；本模块仅持有解析产物的只读内存镜像；
 * - 字典写路径唯一：YAML 编辑器 → `workbench_save_models_yaml` → Rust 原子写 →
 *   `ensureModelsCatalogLoaded(true)` 重载镜像；
 * - 字典读路径唯一：`workbench_read_models_yaml`（文件缺失由 Rust 播种内置模板）；
 * - 失败显式化（fail-closed）：命令 missing / error 返回结构化失败并保留上次
 *   成功镜像（last-known-good 读视图，非伪造数据）；磁盘内容解析失败则镜像
 *   置空进入可修复错误态——绝不回落硬编码种子或 localStorage 旧轨。
 */

import { emitUiEvent } from './uiEvents';
import { invokeTyped } from './tauriInvoke';

export type CatalogModelProtocol =
  | 'openai/chat'
  | 'openai/responses'
  | 'anthropic/messages';

/** 字典条目（字段与 Rust models_yaml.rs serde camelCase 镜像逐字一致） */
export interface CatalogModelSpec {
  model: string;
  vendor: string;
  vendorDisplayName?: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  protocol?: CatalogModelProtocol;
  capabilities?: {
    tools?: boolean;
    image?: boolean;
    video?: boolean;
    reasoning?: boolean;
  };
  pricing?: {
    inputPerMTok?: number;
    outputPerMTok?: number;
    cacheReadPerMTok?: number;
    cacheWritePerMTok?: number;
    billingUnit?: 'token' | 'per_image';
    perImageCost?: number;
    currency?: 'USD' | 'CNY';
  };
}

/** workbench_read_models_yaml 返回面（Rust ReadModelsYamlResult 镜像） */
interface ReadModelsYamlWire {
  path: string;
  content: string;
  models: CatalogModelSpec[];
  template: string;
  seeded: boolean;
  parseError?: { line?: number; column?: number; message: string } | null;
}

export type ModelsCatalogLoadResult = { ok: true; path: string } | { ok: false; error: string };

// ── 内存镜像（只读视图的唯一定点）───────────────────────────────────────────

let mirror: CatalogModelSpec[] = [];
let mirrorVersion = 0;
let loaded = false;
let inflight: Promise<ModelsCatalogLoadResult> | null = null;

/** 磁盘真源路径（Rust 解析返回，展示用；镜像重载后更新） */
let catalogPath = '~/.conex/models.yaml';

export function getModelsCatalogPath(): string {
  return catalogPath;
}

export function getModelsCatalogVersion(): number {
  return mirrorVersion;
}

/**
 * 清空镜像状态（供单测与生命周期管理使用；生产读面不经过此函数）
 */
export function resetModelsCatalogMirror(): void {
  mirror = [];
  mirrorVersion = 0;
  loaded = false;
  inflight = null;
}

/**
 * 幂等加载字典镜像；`force = true` 用于保存后强制重载。
 * 单飞（in-flight 复用）：并发调用共享同一 Promise，不会重复打 IPC。
 * 失败不抛异常，返回结构化结果交调用方呈现（可重试）；失败态下 `loaded`
 * 保持 false，后续调用继续重试——绝不把空镜像冒充成功态。
 */
export async function ensureModelsCatalogLoaded(
  force = false
): Promise<ModelsCatalogLoadResult> {
  if (inflight) return inflight;
  if (loaded && !force) return { ok: true, path: catalogPath };

  inflight = (async (): Promise<ModelsCatalogLoadResult> => {
    const res = await invokeTyped<ReadModelsYamlWire>('workbench_read_models_yaml', {});
    if (res.status === 'missing') {
      return { ok: false, error: '配置文件服务未接线（workbench_read_models_yaml）' };
    }
    if (res.status === 'error') {
      return { ok: false, error: res.message };
    }

    const data = res.data;
    catalogPath = data.path || catalogPath;
    mirrorVersion += 1;
    if (data.parseError) {
      // 磁盘内容解析失败（用户手工改坏）：镜像保持空 + 广播重置，编辑器可修复后保存
      mirror = [];
      loaded = false;
      emitUiEvent('models-catalog-changed', undefined);
      return {
        ok: false,
        error: `models.yaml 解析失败（第 ${data.parseError.line ?? '?'} 行）：${data.parseError.message}`,
      };
    }
    mirror = data.models ?? [];
    loaded = true;
    emitUiEvent('models-catalog-changed', undefined);
    return { ok: true, path: data.path };
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

// ── 同步只读面（读镜像）────────────────────────────────────────────────────

export function listCatalogModels(): readonly CatalogModelSpec[] {
  return mirror;
}

export function findCatalogModel(modelId: string): CatalogModelSpec | undefined {
  const target = modelId.trim().toLowerCase();
  if (!target) return undefined;
  return mirror.find((m) => m.model.toLowerCase() === target);
}

/** 智能模糊搜索（录入联想）：vendor 过滤优先，id/展示名/供应商标签包含匹配 */
export function searchCatalogModels(query: string, vendor?: string): CatalogModelSpec[] {
  const q = query.trim().toLowerCase();
  const v = vendor?.trim().toLowerCase();
  if (!q && !v) return [...mirror];

  return mirror.filter((m) => {
    const modelHit = m.model.toLowerCase().includes(q);
    const vendorMatch =
      !v ||
      m.vendor.toLowerCase() === v ||
      (m.vendorDisplayName?.toLowerCase().includes(v) ?? false);

    // 非 vendor 匹配的条目：仅在模型 id 命中查询时放行（跨厂商直搜 id 场景）
    if (!vendorMatch) return q !== '' && modelHit;
    if (q === '') return true;
    return (
      modelHit ||
      (m.displayName ?? '').toLowerCase().includes(q) ||
      (m.vendorDisplayName ?? '').toLowerCase().includes(q)
    );
  });
}

/** 字典全量四价推荐条目（价格预设单一来源 = YAML pricing 段） */
export function getPresetPricingList(): Array<{
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
  billingUnit?: 'token' | 'per_image';
}> {
  return mirror.map((m) => ({
    model: m.model,
    inputPerMTok: m.pricing?.inputPerMTok ?? 0,
    outputPerMTok: m.pricing?.outputPerMTok ?? 0,
    ...(m.pricing?.cacheReadPerMTok !== undefined && {
      cacheReadPerMTok: m.pricing.cacheReadPerMTok,
    }),
    ...(m.pricing?.cacheWritePerMTok !== undefined && {
      cacheWritePerMTok: m.pricing.cacheWritePerMTok,
    }),
    ...(m.pricing?.billingUnit && { billingUnit: m.pricing.billingUnit }),
  }));
}
