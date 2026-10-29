/**
 * 模型探测与出厂能力字典 IPC 面。
 *
 * 单轨口径：探测命令只认供应商 id（baseUrl/apiKey 由内核从统一树与
 * DPAPI 凭据槽解析）；扫描到的上下文长度批量写回统一树（一次 CAS 提交），
 * 连通测试结果写入探测结果面（modelCatalogMeta）。
 * 出厂数据（定价/上下文字典）唯一来源 = `workbench_read_capability_dictionary`。
 */

import { invokeResult } from './tauriInvoke';
import {
  providerProbePing,
  providerProbeScanModels,
} from './provider-profiles/rustProfileStore';
import { applyCatalogCacheSnapshot } from './pricingResolver';
import type {
  CatalogCacheSnapshot,
  CatalogSnapshotPrice,
  CatalogTier,
} from './pricingTypes';
import { logger } from '../services/LoggerService';
import { errorStore } from '../services/ErrorStore';
import { t } from '../i18n';
import { normalizeModelIdText } from './modelCatalogPure';
import { recordProbeResult } from './modelCatalogMeta';
import { modelsCatalogStore } from './modelsCatalogStore';
import type { ScannedModel } from './provider-profiles/rustProfileStore';
import type {
  CatalogSnapshotEntryWire,
  CatalogSnapshotWire,
} from './pricingTypes';

/**
 * 扫描能力位（引擎 wire 契约：Rust `ScannedCapabilities` camelCase 镜像）。
 * 注意与本地 meta 域的 `ModelCapabilities`（tools/image/video/reasoning）是
 * 两个不同的契约域：引擎 catalog 契约键为 `vision`（→ supports_vision）。
 */
export type ScannedModelCapabilities = {
  tools?: boolean;
  vision?: boolean;
  reasoning?: boolean;
};

/**
 * 扫描供应商可用模型（OpenAI 兼容 /models）。
 * 扫描到的 contextWindow 只填树中缺省的模型（已有值不覆盖），一次 updateTree 提交。
 */
export async function scanProviderModels(
  providerId: string
): Promise<{ ok: boolean; models: string[]; error?: string }> {
  const id = providerId.trim();
  try {
    const res = await providerProbeScanModels(id);
    if (res.status === 'ok') {
      const data = res.data;
      if (data.ok && data.models.length > 0) {
        const modelNames = data.models.map((m: ScannedModel) => m.model);
        await mergeScannedContextWindows(id, data.models);
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

/** 扫描到的上下文长度批量并入统一树：只填洞，一次 CAS 提交；失败显式告警不打断扫描。 */
async function mergeScannedContextWindows(
  providerId: string,
  models: ScannedModel[]
): Promise<void> {
  const withCtx = models.filter(
    (m) => typeof m.contextWindow === 'number' && m.contextWindow > 0
  );
  if (withCtx.length === 0) return;
  const state = modelsCatalogStore.getState();
  const provider = state.tree.providers[providerId];
  if (!state.loaded || !provider) return;

  const tree = structuredClone(state.tree);
  const target = tree.providers[providerId]!;
  let changed = false;
  for (const m of withCtx) {
    const spec = target.models.find((x) => x.id === m.model);
    if (spec && !spec.contextWindow) {
      spec.contextWindow = m.contextWindow;
      changed = true;
    }
  }
  if (!changed) return;
  const result = await modelsCatalogStore.updateTree(tree);
  if (!result.ok) {
    logger.warn(
      t('models.probe.contextWindowWriteFailed', { error: result.error }),
      {
        module: 'modelCatalogIpc',
      }
    );
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
 * 出厂能力字典 wire → pricingStore 快照（纯转换，可单测）。
 *
 * 索引键 = **模型 id**（含 `apiModel` 点号异形别名）。
 *
 * 注意：索引键**不是** `modelRefKey({ providerId, modelId })` —— 配置树侧的身份键
 * 与本快照的索引键是两个不同口径，见下。
 *
 * 为什么可以按 id 索引（而不是 `(providerId, modelId)` 二元组）：
 * 出厂字典是**厂商维度的出厂目录**，而配置树的 `providerId` 是用户侧供应商键
 * （`custom-ms983y2d` / `ollama` / `deepseek` …），两者**不同命名空间**
 * （字典厂商为 `openai` / `google` / `dashscope` / `kimi` …），配置树的
 * `ProviderSpec` 也没有 vendor 字段（`crates/agent-provider/src/models/catalog_types.rs:48-73`）。
 * 实测字典内 **156 个模型 id、0 个跨厂商重复**（`catalog.json` 全量统计），
 * 故 id 在字典内是**唯一键**——按 id 查找**不含任何猜测**。
 *
 * 不变量守卫：若某 id 出现多条且价格不一致（字典不变量被破坏），
 * **丢弃该 id 的全部条目**（fail-closed「未收录」）并显式告警，
 * **绝不**任选一个。该不变量另由 Rust 侧
 * `models/ssot_convergence_tests.rs` 的 `dictionary_model_ids_are_unique_keys` 钉死。
 *
 * 无 substring / 前缀后缀 / 模糊回退；null 价 = 未收录 → 字段缺失。
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

  /** 同 id 多条时用于冲突判定：签名相同视为同一条目的重复投影，不同则冲突。 */
  const seen = new Map<string, string>();

  for (const entry of wire.entries) {
    const model = normalizeModelIdText(entry?.model);
    if (!model) continue;
    const tiers = toCatalogTierWire(entry.tieredPricing);
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
      ...(typeof entry.cacheWritePrice5m === 'number'
        ? { writePerMTok5m: entry.cacheWritePrice5m }
        : {}),
      ...(typeof entry.cacheWritePrice1h === 'number'
        ? { writePerMTok1h: entry.cacheWritePrice1h }
        : {}),
      ...(entry.cacheWriteFree === true ? { writeFree: true } : {}),
      ...(entry.currency === 'USD' || entry.currency === 'CNY'
        ? { currency: entry.currency }
        : {}),
      ...(tiers ? { tiered: tiers } : {}),
    };
    const signature = JSON.stringify(price);
    // 主 id 与别名共用**同一键命名空间**（查找时都按 id 查），故共用同一张签名表，
    // 冲突语义一致：同一键被不同价主张 → 该键作废（fail-closed「未收录」）。
    const claim = (key: string): boolean => {
      const previous = seen.get(key);
      if (previous === '\u0000CONFLICT') return false;
      if (previous !== undefined && previous !== signature) {
        logger.error(
          `出厂能力字典出现同键不同价的条目（key=${key}），该键按「未收录」处理`
        );
        delete prices[key];
        seen.set(key, '\u0000CONFLICT');
        return false;
      }
      seen.set(key, signature);
      prices[key] = price;
      return true;
    };

    claim(model);

    // apiModel 别名（点号异形，如 gemini-3.1-pro-preview）→ 同一价格索引。
    //
    // **同样 fail-closed**：字典里存在多组别名被不同条目主张且价格不同的情况
    // （实测 19 组，例如 `glm-4.5-air` 同时被 `glm-4-5-air`(USD) 与
    // `glm-4-5-air-cny`(CNY) 主张），也存在别名撞其他条目主 id 的情况。
    // 旧实现用「先到先得」(`!prices[apiModel]`) ⇒ 命中结果取决于 `entries` 顺序
    // = **静默任选**，与主 id 的守卫精神相反。现由 `claim` 统一处置。
    const apiModel = normalizeModelIdText(entry.apiModel);
    if (apiModel && apiModel !== model) {
      claim(apiModel);
    }
  }
  return {
    version: typeof wire.version === 'number' ? wire.version : 0,
    prices,
  };
}

/**
 * 拉取**出厂能力字典**的只读投影（`workbench_read_capability_dictionary`
 * → `applyCatalogCacheSnapshot`）。
 *
 * 数据源唯一性：出厂字典（Rust 侧 `catalog.json` 编译期打包）是定价 / 上下文 /
 * 模态 / 思考档位等**出厂数据**的唯一来源；前端不再持有任何本地副本
 * （`pricingCatalogData*.ts` 六份静态表与 `modelsAutofillBaselineData.json`
 * 已物理删除，见 docs/provider-single-track-convergence/04-...方案.md 阶段 3）。
 *
 * 失败语义 = **fail-closed**：命令缺失 / invoke 失败 / 载荷非法一律显式告警并
 * 返回 false，由消费面呈现「未收录」态。**禁止**回退到任何本地静态表——那会让
 * 界面显示过期价格或 0 成本（比空白更危险）。
 *
 * @returns 是否成功注入（false = 未收录，消费面必须显式呈现）
 */
export async function fetchCatalogSnapshot(): Promise<boolean> {
  try {
    const res = await invokeResult<CatalogSnapshotWire>(
      'workbench_read_capability_dictionary',
      {}
    );
    if (res.status !== 'ok') {
      logger.error(
        `出厂能力字典读取失败（${res.status}）${res.status === 'error' ? `：${res.message}` : ''}，定价与能力面按「未收录」呈现`
      );
      try {
        errorStore.push({
          code: 'MODEL_CATALOG_DEGRADED',
          module: 'modelCatalog',
          severity: 'error',
          message: '出厂能力字典读取失败，定价与能力面按「未收录」呈现',
        });
      } catch {
        /* ignore */
      }
      return false;
    }
    if (!Array.isArray(res.data?.entries) || res.data.entries.length === 0) {
      logger.error('出厂能力字典载荷非法（entries 缺失或为空）');
      try {
        errorStore.push({
          code: 'MODEL_CATALOG_DEGRADED',
          module: 'modelCatalog',
          severity: 'error',
          message: '出厂能力字典载荷非法，定价与能力面按「未收录」呈现',
        });
      } catch {
        /* ignore */
      }
      return false;
    }
    applyCatalogCacheSnapshot(toCatalogCacheSnapshot(res.data));
    return true;
  } catch (e) {
    logger.error('出厂能力字典读取抛异常，定价与能力面按「未收录」呈现：', {
      module: 'modelCatalog',
      err:
        e instanceof Error
          ? { message: e.message, stack: e.stack, name: e.name }
          : { message: String(e) },
    });
    try {
      errorStore.push({
        code: 'MODEL_CATALOG_DEGRADED',
        module: 'modelCatalog',
        severity: 'error',
        message: '出厂能力字典读取抛异常，定价与能力面按「未收录」呈现',
      });
    } catch {
      /* ignore */
    }
    return false;
  }
}

/** 轻量连通测试：发极短 completion（结果写入探测结果面）。 */
export async function testProviderModel(
  providerId: string,
  model: string
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const id = providerId.trim();
  try {
    const res = await providerProbePing(id, model || undefined);
    if (res.status === 'ok') {
      const data = res.data;
      recordProbeResult(id, model, {
        ok: data.ok,
        latencyMs: data.latencyMs,
        at: Date.now(),
        error: data.error,
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
