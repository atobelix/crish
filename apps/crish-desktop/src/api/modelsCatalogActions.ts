/**
 * modelsCatalogActions.ts —— 树状模型配置纯函数 Actions
 *
 * 规范：极简、不可变、无副作用的纯函数操作
 */

import type { ModelsYamlTree, ProviderSpec, ModelSpec } from './modelsCatalogTypes';
import { findAutofillModel } from './modelsAutofillBaseline';

/**
 * 纯函数 action: 添加供应商
 */
export function addProvider(
  tree: ModelsYamlTree,
  providerId: string,
  provider: ProviderSpec
): ModelsYamlTree {
  const normPId = providerId.trim().toLowerCase();
  return {
    ...tree,
    version: 2,
    providers: {
      ...tree.providers,
      [normPId]: {
        ...provider,
        models: provider.models ? [...provider.models] : [],
      },
    },
  };
}

/**
 * 纯函数 action: 更新供应商
 */
export function updateProvider(
  tree: ModelsYamlTree,
  providerId: string,
  patch: Partial<ProviderSpec>
): ModelsYamlTree {
  const normPId = providerId.trim().toLowerCase();
  const existing = tree.providers[normPId];
  if (!existing) {
    throw new Error(`供应商不存在: ${providerId}`);
  }

  return {
    ...tree,
    version: 2,
    providers: {
      ...tree.providers,
      [normPId]: {
        ...existing,
        ...patch,
        models: patch.models ? [...patch.models] : existing.models,
      },
    },
  };
}

/**
 * 纯函数 action: 移除供应商
 */
export function removeProvider(tree: ModelsYamlTree, providerId: string): ModelsYamlTree {
  const normPId = providerId.trim().toLowerCase();
  const nextProviders = { ...tree.providers };
  delete nextProviders[normPId];

  return {
    ...tree,
    version: 2,
    providers: nextProviders,
  };
}

/**
 * 纯函数 action: 添加模型（智能预填驱动）
 * 在 addModel 时，调用 findAutofillModel(id) 进行智能预填，
 * 若匹配到 2026 最新官方模型则自动补全上下文、模态、思考档位与四维价格，用户可自由改写。
 */
export function addModel(
  tree: ModelsYamlTree,
  providerId: string,
  modelInput: Partial<ModelSpec> & { id: string }
): ModelsYamlTree {
  const normPId = providerId.trim().toLowerCase();
  const provider = tree.providers[normPId];
  if (!provider) {
    throw new Error(`供应商不存在: ${providerId}`);
  }

  const rawId = (modelInput.id || '').trim();
  if (!rawId) {
    throw new Error('模型 ID 不能为空');
  }

  // 1. 智能预填：若匹配到 2026 最新官方模型则自动补全基线配置
  const autofill = findAutofillModel(rawId, normPId);
  const baseModel: ModelSpec = autofill
    ? { ...autofill }
    : {
        id: rawId,
        displayName: rawId,
        enabled: true,
      };

  // 2. 合并用户传入的个性化改写字段
  const finalModel: ModelSpec = {
    ...baseModel,
    ...modelInput,
    id: rawId, // 保证 ID 绝对一致
  };

  // 3. 保序追加或同 ID 原地更新
  const existingModels = provider.models || [];
  const existingIndex = existingModels.findIndex(
    (m) => m.id.trim().toLowerCase() === rawId.toLowerCase()
  );

  const updatedModels = [...existingModels];
  if (existingIndex >= 0) {
    updatedModels[existingIndex] = finalModel;
  } else {
    updatedModels.push(finalModel);
  }

  return {
    ...tree,
    version: 2,
    providers: {
      ...tree.providers,
      [normPId]: {
        ...provider,
        models: updatedModels,
      },
    },
  };
}

/**
 * 纯函数 action: 更新模型属性
 */
export function updateModel(
  tree: ModelsYamlTree,
  providerId: string,
  modelId: string,
  patch: Partial<ModelSpec>
): ModelsYamlTree {
  const normPId = providerId.trim().toLowerCase();
  const provider = tree.providers[normPId];
  if (!provider) {
    throw new Error(`供应商不存在: ${providerId}`);
  }

  const normMId = modelId.trim().toLowerCase();
  const existingModels = provider.models || [];
  const index = existingModels.findIndex((m) => m.id.trim().toLowerCase() === normMId);
  if (index < 0) {
    throw new Error(`模型不存在: ${modelId} (供应商: ${providerId})`);
  }

  const updatedModels = [...existingModels];
  const currentModel = existingModels[index]!;
  // spread 保留未出现在 patch 中的 thinking / modalities / pricing 等字段
  updatedModels[index] = {
    ...currentModel,
    ...patch,
    id: patch.id ? patch.id.trim() : currentModel.id,
  };

  return {
    ...tree,
    version: 2,
    providers: {
      ...tree.providers,
      [normPId]: {
        ...provider,
        models: updatedModels,
      },
    },
  };
}

/**
 * 纯函数 action: 移除模型
 */
export function removeModel(
  tree: ModelsYamlTree,
  providerId: string,
  modelId: string
): ModelsYamlTree {
  const normPId = providerId.trim().toLowerCase();
  const provider = tree.providers[normPId];
  if (!provider) {
    throw new Error(`供应商不存在: ${providerId}`);
  }

  const normMId = modelId.trim().toLowerCase();
  const updatedModels = (provider.models || []).filter(
    (m) => m.id.trim().toLowerCase() !== normMId
  );

  return {
    ...tree,
    version: 2,
    providers: {
      ...tree.providers,
      [normPId]: {
        ...provider,
        models: updatedModels,
      },
    },
  };
}
