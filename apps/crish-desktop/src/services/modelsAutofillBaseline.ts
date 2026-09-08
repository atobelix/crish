/**
 * modelsAutofillBaseline.ts —— 2026 官方权威模型智能预填基线库 (Smart Autofill Baseline)
 *
 * 核心定位与最高铁律（严谨守则）：
 * 1. 【字典表本质定位明确】：
 *    本智能预填库绝非运行时的物理真源，更不是默认启动就已激活的供应商。
 *    它的唯一职责是：当用户在界面上手动添加模型或输入模型 ID（如 deepseek-v4-pro, claude-5,
 *    gpt-5.6-sol, qwen-3.8-max）时，为用户做“智能预填写（Smart Autofill）”，辅助自动补齐展示名、
 *    真实物理上下文、最大输出限制、拍平思考档位映射与四维独立单价。
 * 2. 【物理真源唯一】：
 *    系统的物理真源永远是 `~/.conex/models.yaml`。用户可任意修改或增删，
 *    运行时完全由用户保存在 models.yaml 中的快照驱动，与本预填库彻底解耦。
 * 3. 【2026 官方一手权威数据（静态字典剥离）】：
 *    静态字典数据独立存放于同目录 `modelsAutofillBaselineData.json`，
 *    彻底根除代码膨胀并对标 `docs/model-capability/surveys/01-主流模型多源权威数据全景调研.md`。
 */

import type { ModelSpec, ProviderSpec, ModelsYamlTree, ModelProtocol } from '../api/modelCatalogTypes';
import baselineData from './modelsAutofillBaselineData.json';

export interface CommonProviderSeedSuggestion {
  providerId: string; displayName: string; baseUrl: string; protocol: ModelProtocol;
  description?: string; recommendedModels: string[]; template: ProviderSpec;
}

const clone = <T>(val: T): T => JSON.parse(JSON.stringify(val));

/** 2026 官方权威主流模型全景预填基线树 */
export const AUTOFILL_BASELINE_2026: ModelsYamlTree = {
  version: baselineData.version,
  providers: baselineData.providers as unknown as Record<string, ProviderSpec>,
};

/** 常用供应商种子建议列表（按推荐顺序排列） */
export const COMMON_PROVIDER_SEEDS: CommonProviderSeedSuggestion[] = baselineData.providerSeeds.map((s) => ({
  ...s, protocol: s.protocol as ModelProtocol,
  template: (AUTOFILL_BASELINE_2026.providers[s.providerId] ?? { displayName: s.displayName, baseUrl: s.baseUrl, protocol: s.protocol as ModelProtocol, models: [] }) as ProviderSpec,
}));

export const COMMON_PROVIDER_SUGGESTIONS = COMMON_PROVIDER_SEEDS;

/** 提取模型纯标识（去除供应商前缀，如 "deepseek/deepseek-v4-pro" -> "deepseek-v4-pro"） */
export const extractBareModelId = (id: string): string => {
  const i = id.lastIndexOf('/');
  return i >= 0 ? id.slice(i + 1) : id;
};

/** 规范化模型 ID 键（小写、去前后空格、点与下划线转中划线） */
export const normalizeModelId = (id: string): string =>
  extractBareModelId(id).trim().toLowerCase().replace(/[_\.]/g, '-');

/** 纯字母数字规范化键（剥除所有分隔符，消除 qwen-3.8-max 与 qwen3.8-max 差异） */
export const toCanonicalModelId = (id: string): string =>
  extractBareModelId(id).trim().toLowerCase().replace(/[-_\.]/g, '');

/** 获取供应商预填种子配置副本 */
export function getProviderSeed(providerId: string): ProviderSpec | undefined {
  if (!providerId) return undefined;
  const p = AUTOFILL_BASELINE_2026.providers[providerId.toLowerCase()];
  return p ? clone(p) : undefined;
}

/** 智能检索供应商规格 */
export function findAutofillProvider(idOrName: string): ProviderSpec | null {
  if (!idOrName?.trim()) return null;
  const key = idOrName.trim().toLowerCase();
  const direct = AUTOFILL_BASELINE_2026.providers[key];
  if (direct) return clone(direct);
  const found = Object.values(AUTOFILL_BASELINE_2026.providers).find(
    (p) => p.displayName.toLowerCase() === key || p.displayName.toLowerCase().includes(key)
  );
  return found ? clone(found) : null;
}

/** 供应商作用域限定的模型规格检索器 */
export function findAutofillModelSpec(providerId: string, modelId: string): ModelSpec | undefined {
  if (!providerId || !modelId) return undefined;
  const normPId = providerId.trim().toLowerCase();
  const p =
    AUTOFILL_BASELINE_2026.providers[normPId] ||
    Object.values(AUTOFILL_BASELINE_2026.providers).find((x) => x.displayName.toLowerCase() === normPId);
  if (!p) return (findAutofillModel(modelId) as ModelSpec) ?? undefined;

  const low = modelId.trim().toLowerCase(), norm = normalizeModelId(low);
  const matched = p.models.find((m) => {
    const ml = m.id.toLowerCase();
    return ml === low || extractBareModelId(ml) === low || normalizeModelId(ml) === norm;
  });
  return matched ? clone(matched) : (findAutofillModel(modelId) as ModelSpec) ?? undefined;
}

export const getAutofillModelSpec = findAutofillModelSpec;

/** 智能预填模型检索器：支持精确、标点容错及包含模糊匹配 */
export function findAutofillModel(id: string, providerId?: string): (ModelSpec & Partial<ModelSpec>) | null {
  if (!id?.trim()) return null;
  const raw = id.trim();
  if (providerId) {
    const scoped = findAutofillModelSpec(providerId, raw);
    if (scoped) return scoped;
  }

  const low = raw.toLowerCase(), bare = extractBareModelId(low);
  const norm = normalizeModelId(bare), can = toCanonicalModelId(bare);

  let bestMatch: ModelSpec | null = null;
  for (const provider of Object.values(AUTOFILL_BASELINE_2026.providers)) {
    for (const model of provider.models) {
      const ml = model.id.toLowerCase(), mb = extractBareModelId(ml);
      const mn = normalizeModelId(mb), mc = toCanonicalModelId(mb);

      if (ml === low || mb === low || mb === bare || mn === norm || mc === can) return clone(model);
      if (
        !bestMatch &&
        (mb.includes(bare) || bare.includes(mb) || mn.includes(norm) || norm.includes(mn) || mc.includes(can) || can.includes(mc))
      ) {
        bestMatch = model;
      }
    }
  }
  return bestMatch ? clone(bestMatch) : null;
}

/** 自动补全建议列表生成（供输入框下拉联想使用） */
export function getAutofillSuggestions(query: string, providerId?: string, limit = 8): ModelSpec[] {
  const results: ModelSpec[] = [];
  const qLow = (query || '').trim().toLowerCase(), qNorm = normalizeModelId(qLow);

  const providers: ProviderSpec[] =
    providerId && AUTOFILL_BASELINE_2026.providers[providerId.toLowerCase()]
      ? [AUTOFILL_BASELINE_2026.providers[providerId.toLowerCase()]!]
      : Object.values(AUTOFILL_BASELINE_2026.providers);

  for (const p of providers) {
    for (const m of p.models) {
      if (results.length >= limit) return results;
      if (!qLow) { results.push(clone(m)); continue; }
      const ml = m.id.toLowerCase(), mn = (m.displayName || '').toLowerCase();
      if (ml.includes(qLow) || mn.includes(qLow) || normalizeModelId(ml).includes(qNorm)) results.push(clone(m));
    }
  }
  return results;
}
