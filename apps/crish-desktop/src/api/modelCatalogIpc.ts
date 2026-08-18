/**
 * 模型目录 IPC 面（拆自 modelCatalog.ts）：扫描 / 上送 / 快照拉取 / 连通测试 /
 * Picker 列表。含网络与 Tauri 副作用，调用 invokeResult 与 providerProbe*。
 */

import { loadProfiles, type ProviderProfile } from './providerProfiles';
import { invokeResult } from './tauriInvoke';
import {
  providerProbePing,
  providerProbeScanModels,
  type ScannedModel as WireScannedModel,
} from './provider-profiles/rustProfileStore';
import {
  applyCatalogCacheSnapshot,
  type CatalogCacheSnapshot,
  type CatalogSnapshotPrice,
  type CatalogTier,
} from './pricingStore';
import { logger } from '../services/LoggerService';
import { errorStore } from '../services/ErrorStore';
import { normalizeModelIdText } from './modelCatalogPure';
import { upsertModelMetaExport, getModelMeta } from './modelCatalogMeta';
import type {
  CatalogModelEntry,
  CatalogSnapshotEntryWire,
  CatalogSnapshotWire,
  ModelCapabilities,
  ScannedModel,
} from './modelCatalogTypes';
import {
  buildCatalogEntriesFromProfiles,
  pickDefaultCatalogEntry,
} from './modelCatalogPure';
import type { PickDefaultCatalogOpts } from './modelCatalogTypes';

/** 扫描提供商模型列表（OpenAI 兼容 /models） */
export async function scanProviderModels(
  profile: ProviderProfile
): Promise<{ ok: boolean; models: string[]; error?: string }> {
  const fresh = loadProfiles().find((p) => p.id === profile.id) || profile;
  try {
    const res = await providerProbeScanModels(fresh.id);
    if (res.status === 'ok') {
      const data = res.data;
      if (data.ok && data.models.length > 0) {
        const modelNames = data.models.map((m: WireScannedModel) => m.model);
        for (const m of data.models) {
          if (m.contextWindow && m.contextWindow > 0) {
            upsertModelMetaExport(fresh.id, m.model, {
              contextLength: m.contextWindow,
            });
          }
        }
        return { ok: true, models: modelNames };
      }
      return {
        ok: false,
        models: [],
        error: data.error || '未能检测到服务器可用模型',
      };
    }
    if (res.status === 'error') {
      return { ok: false, models: [], error: res.message };
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { ok: false, models: [], error };
  }
  return { ok: false, models: [], error: '扫描服务未就绪' };
}

/**
 * 扫描结果 → catalog_refresh 上送形状（纯）。
 * 仅映射窗口 / 能力位；vendor / maxOutputTokens 扫描不提供 → 缺省。
 */
export function buildScannedModelWire(
  model: string,
  contextWindow?: number | undefined,
  capabilities?: ModelCapabilities | undefined
): ScannedModel {
  const m = normalizeModelIdText(model);
  const out: ScannedModel = { model: m };
  if (!m) return out;
  if (contextWindow && contextWindow > 0) out.contextWindow = contextWindow;
  if (capabilities && Object.keys(capabilities).length > 0) {
    out.capabilities = { ...capabilities };
  }
  return out;
}

/**
 * 扫描结果上送合并（P3 步骤 5b / §3.1.3 数据来源策略 2）。
 *
 * 经 Tauri `catalog_refresh` 命令合并（仅窗口 / 能力位，不覆盖价格）；
 * 命令缺失 / invoke 失败 / 非 Tauri 环境一律降级：logger.warn 记录，
 * 绝不抛出——扫描流程不因上送失败而中断（invokeResult 本身不抛，外层
 * try/catch 兜底保证恒不抛）。
 */
export async function uploadScannedModels(
  provider: string,
  scan: readonly ScannedModel[]
): Promise<void> {
  try {
    const res = await invokeResult<unknown>('catalog_refresh', {
      provider,
      scan,
    });
    if (res.status !== 'ok') {
      // 修复 4：降级推入 errorStore（info 级，可自动解决）
      logger.warn(
        `模型目录上送合并跳过（${res.status}）${res.status === 'error' ? `：${res.message}` : ''}，不阻塞扫描`
      );
      try {
        errorStore.push({
          code: 'MODEL_CATALOG_DEGRADED',
          module: 'modelCatalog',
          severity: 'info',
          message: '模型目录上送合并跳过，不阻塞扫描',
          autoResolve: true,
        });
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    logger.warn('模型目录上送合并失败，不阻塞扫描：', {
      module: 'modelCatalog',
      err: e instanceof Error
        ? { message: e.message, stack: e.stack, name: e.name }
        : { message: String(e) },
    });
    try {
      errorStore.push({
        code: 'MODEL_CATALOG_DEGRADED',
        module: 'modelCatalog',
        severity: 'info',
        message: '模型目录上送合并失败，不阻塞扫描',
        autoResolve: true,
      });
    } catch {
      /* ignore */
    }
  }
}

/** 条目 tiered 档映射（Rust TieredPriceTier camelCase → 前端 CatalogTier） */
function toCatalogTierWire(
  tiers: CatalogSnapshotEntryWire['tieredPricing']
): CatalogTier[] | undefined {
  if (!Array.isArray(tiers) || tiers.length === 0) return undefined;
  const out: CatalogTier[] = [];
  for (const t of tiers) {
    if (typeof t?.minTokens !== 'number' || t.minTokens < 0) continue;
    out.push({
      minTokens: t.minTokens,
      ...(typeof t.maxTokens === 'number' ? { maxTokens: t.maxTokens } : {}),
      ...(typeof t.inputPrice === 'number'
        ? { inputPerMTok: t.inputPrice }
        : {}),
      ...(typeof t.outputPrice === 'number'
        ? { outputPerMTok: t.outputPrice }
        : {}),
      ...(typeof t.cacheReadPrice === 'number'
        ? { cacheReadPerMTok: t.cacheReadPrice }
        : {}),
      ...(typeof t.cacheWritePrice === 'number'
        ? { cacheWritePerMTok: t.cacheWritePrice }
        : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * catalog_get wire → pricingStore 快照（纯转换，可单测）。
 * 索引键：model 主键 + apiModel 别名（点号异形兼容）；null 价 = 未收录 → 缺失
 * （回退下级解析链）；tieredPricing 映射为分档消费结构。
 */
export function toCatalogCacheSnapshot(
  wire: CatalogSnapshotWire | null | undefined
): CatalogCacheSnapshot {
  const prices: Record<string, CatalogSnapshotPrice> = {};
  if (!wire || !Array.isArray(wire.entries)) {
    return {
      version: typeof wire?.version === 'number' ? wire.version : 0,
      prices,
    };
  }
  for (const entry of wire.entries) {
    const model = normalizeModelIdText(entry?.model);
    if (!model) continue;
    const price: CatalogSnapshotPrice = {
      ...(typeof entry.inputPrice === 'number'
        ? { inputPerMTok: entry.inputPrice }
        : {}),
      ...(typeof entry.outputPrice === 'number'
        ? { outputPerMTok: entry.outputPrice }
        : {}),
      ...(typeof entry.cacheReadPrice === 'number'
        ? { readPerMTok: entry.cacheReadPrice }
        : {}),
      ...(typeof entry.cacheWritePrice === 'number'
        ? { writePerMTok: entry.cacheWritePrice }
        : {}),
      ...(toCatalogTierWire(entry.tieredPricing)
        ? { tiered: toCatalogTierWire(entry.tieredPricing) }
        : {}),
    };
    prices[model] = price;
    // apiModel 别名（点号异形，如 gemini-3.1-pro-preview）→ 同一价格索引
    const apiModel = normalizeModelIdText(entry.apiModel);
    if (apiModel && apiModel !== model && !prices[apiModel]) {
      prices[apiModel] = price;
    }
  }
  return {
    version: typeof wire.version === 'number' ? wire.version : 0,
    prices,
  };
}

/**
 * 拉取运行时模型目录快照（catalog_get → applyCatalogCacheSnapshot）。
 *
 * - 成功：快照注入 pricingStore（版本号幂等，重复调用安全）；
 * - 命令缺失 / invoke 失败 / 载荷非法：logger.warn 降级（静态表兜底），
 *   恒不抛（invokeResult 不抛 + 外层 try/catch 兜底）。
 *
 * @returns 是否成功注入（false = 降级静态表）
 */
export async function fetchCatalogSnapshot(): Promise<boolean> {
  try {
    const res = await invokeResult<CatalogSnapshotWire>('catalog_get', {});
    if (res.status !== 'ok') {
      // 修复 4：降级推入 errorStore（info 级，可自动解决）
      logger.warn(
        `模型目录快照拉取跳过（${res.status}）${res.status === 'error' ? `：${res.message}` : ''}，定价回退静态表`
      );
      try {
        errorStore.push({
          code: 'MODEL_CATALOG_DEGRADED',
          module: 'modelCatalog',
          severity: 'info',
          message: '模型目录快照拉取跳过，定价回退静态表',
          autoResolve: true,
        });
      } catch {
        /* ignore */
      }
      return false;
    }
    if (!Array.isArray(res.data?.entries) || res.data.entries.length === 0) {
      logger.warn('模型目录快照载荷非法（entries 缺失），定价回退静态表');
      try {
        errorStore.push({
          code: 'MODEL_CATALOG_DEGRADED',
          module: 'modelCatalog',
          severity: 'info',
          message: '模型目录快照载荷非法，定价回退静态表',
          autoResolve: true,
        });
      } catch {
        /* ignore */
      }
      return false;
    }
    applyCatalogCacheSnapshot(toCatalogCacheSnapshot(res.data));
    return true;
  } catch (e) {
    logger.warn('模型目录快照拉取失败，定价回退静态表：', {
      module: 'modelCatalog',
      err: e instanceof Error
        ? { message: e.message, stack: e.stack, name: e.name }
        : { message: String(e) },
    });
    try {
      errorStore.push({
        code: 'MODEL_CATALOG_DEGRADED',
        module: 'modelCatalog',
        severity: 'info',
        message: '模型目录快照拉取失败，定价回退静态表',
        autoResolve: true,
      });
    } catch {
      /* ignore */
    }
    return false;
  }
}

/** 轻量连通测试：发极短 completion */
export async function testProviderModel(
  profile: ProviderProfile,
  model: string
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const fresh = loadProfiles().find((p) => p.id === profile.id) || profile;
  try {
    const res = await providerProbePing(fresh.id, model || undefined);
    if (res.status === 'ok') {
      const data = res.data;
      upsertModelMetaExport(fresh.id, model, {
        lastTest: {
          ok: data.ok,
          latencyMs: data.latencyMs,
          at: Date.now(),
          error: data.error,
        },
      });
      return { ok: data.ok, latencyMs: data.latencyMs, error: data.error };
    }
    if (res.status === 'error') {
      return { ok: false, error: res.message };
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { ok: false, error };
  }
  return { ok: false, error: '探活服务未就绪' };
}

/** 启用中的提供商（有密钥的优先展示） */
export function listPickerProfiles(): ProviderProfile[] {
  return loadProfiles().filter((p) => p.enabled !== false);
}

/**
 * Picker 用：仅返回真实配置在 profile 中、且 meta 未禁用的模型。
 * 经 normalize → dedupe → usable 管道；不写死 vendor 演示表。
 * 空列表时返回 []（调用方不得回落 mimo 等硬编码默认）。
 */
export function listAvailablePickerModels(): CatalogModelEntry[] {
  return buildCatalogEntriesFromProfiles(
    listPickerProfiles(),
    (profileId, model) => {
      const meta = getModelMeta(profileId, model);
      return meta.enabled !== false;
    }
  );
}

/**
 * 从当前本机目录挑选默认模型（读 LS，无副作用）。
 * 空 catalog → null，**不**发明远程 vendor 默认。
 */
export function pickDefaultFromLocalCatalog(
  opts?: PickDefaultCatalogOpts
): CatalogModelEntry | null {
  return pickDefaultCatalogEntry(listAvailablePickerModels(), opts);
}
