/**
 * probeIncremental.ts —— 遵循反过度设计红线的纯增量探测追加器
 *
 * 铁律（用户微调资产 100% 绝对保护）：
 * 1. 坚决废除三向合并（Three-way merge）与 AST 语法树比对过度设计；
 * 2. 采用“只读 ID 差集纯增量追加算法”：newIds = probedIds \ existingIds；
 * 3. 仅对纯新增 ID 差集执行末尾追加，绝对不覆写或修改任何已存在模型的任何属性；
 * 4. 用户手工调整的上下文、展示名、思考档位与自谈费率受到 100% 绝对物理保护。
 */

import type { ModelsYamlTree, ModelSpec, ProviderSpec } from './modelsCatalogTypes';
import { modelsCatalogStore } from './modelsCatalogStore';
import { findAutofillModel } from './modelsAutofillBaseline';

export interface IncrementalProbeResult {
  providerId: string;
  totalProbed: number;
  existingRetained: number;
  newAppended: number;
  appendedModelIds: string[];
}

/**
 * 纯函数：对单供应商规格执行差集探测计算（无副作用）
 */
export function pureIncrementalProbe(
  provider: ProviderSpec,
  probedRawIds: string[],
  providerId?: string
): { updatedProvider: ProviderSpec; result: IncrementalProbeResult } {
  const normPId = (providerId || '').trim().toLowerCase();

  // 1. 提取本地已有模型 ID 集合（标准化小写）
  const existingIdSet = new Set<string>();
  for (const m of provider.models || []) {
    if (m?.id) {
      existingIdSet.add(m.id.trim().toLowerCase());
    }
  }

  // 2. 远端 ID 过滤与大小写不敏感保序去重
  const seenLower = new Set<string>();
  const uniqueProbedIds: string[] = [];
  for (const raw of probedRawIds || []) {
    const trimmed = (raw || '').trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (!seenLower.has(lower)) {
      seenLower.add(lower);
      uniqueProbedIds.push(trimmed);
    }
  }

  // 3. 计算纯新增 ID 差集：newlyDiscoveredIds = probedIds \ existingIds
  const newlyDiscoveredIds: string[] = [];
  for (const rawId of uniqueProbedIds) {
    if (!existingIdSet.has(rawId.toLowerCase())) {
      newlyDiscoveredIds.push(rawId);
    }
  }

  if (newlyDiscoveredIds.length === 0) {
    return {
      updatedProvider: provider,
      result: {
        providerId: normPId,
        totalProbed: uniqueProbedIds.length,
        existingRetained: existingIdSet.size,
        newAppended: 0,
        appendedModelIds: [],
      },
    };
  }

  // 4. 为每个新发现的 ID 构建 ModelSpec
  const newModelSpecs: ModelSpec[] = newlyDiscoveredIds.map((id) => {
    // 优先从 2026 智能预填基线库中匹配成熟元数据
    const autofill = findAutofillModel(id, normPId);
    if (autofill) {
      return {
        ...autofill,
        id, // 保留探测到的真实 ID
      };
    }

    // 预填库未收录的模型：生成安全基础模板（不支持思考推理，thinking 字段缺省）
    return {
      id,
      displayName: id,
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      enabled: true,
    };
  });

  // 5. 纯增量追加到 provider.models 末尾
  // 核心铁律：已有模型对象与所有手工属性 100% 毫发无损！
  const updatedProvider: ProviderSpec = {
    ...provider,
    models: [...(provider.models || []), ...newModelSpecs],
  };

  return {
    updatedProvider,
    result: {
      providerId: normPId,
      totalProbed: uniqueProbedIds.length,
      existingRetained: existingIdSet.size,
      newAppended: newModelSpecs.length,
      appendedModelIds: newlyDiscoveredIds,
    },
  };
}

/**
 * 对全局 Store 中的指定供应商执行纯增量探测合并并持久化落盘
 */
export async function applyIncrementalProbe(
  providerId: string,
  probedRawIds: string[]
): Promise<IncrementalProbeResult> {
  const currentTree = modelsCatalogStore.getState().tree;
  const normPId = (providerId || '').trim().toLowerCase();
  const provider = currentTree.providers[normPId];

  if (!provider) {
    throw new Error(`无法对未配置的供应商执行探测追加: ${providerId}`);
  }

  const { updatedProvider, result } = pureIncrementalProbe(provider, probedRawIds, normPId);

  if (result.newAppended === 0) {
    return result;
  }

  const updatedTree: ModelsYamlTree = {
    ...currentTree,
    providers: {
      ...currentTree.providers,
      [normPId]: updatedProvider,
    },
  };

  const updateRes = await modelsCatalogStore.updateTree(updatedTree);
  if (!updateRes.ok) {
    throw new Error(`增量追加写盘失败: ${updateRes.error}`);
  }

  return result;
}
