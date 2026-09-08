import {
  type ModelCapabilityKey,
  MODEL_CAPABILITY_OPTIONS,
  setModelCapability,
  setModelContextLength,
  setModelMaxOutputTokens,
  setModelDisplayName,
  setModelThinkingLevel,
  setModelProtocol,
  setModelModalities,
  setModelThinking,
  setModelPricing,
} from '../../api/modelCatalog';
import { findCatalogModel } from '../../api/modelsCatalogStore';
import { resolveModelPrice, upsertPrice } from '../../api/pricingStore';

import type { ModelProtocol } from '../../api/modelCatalogTypes';

export interface AddModelDraft {
  modelId: string;
  displayName: string;
  contextLength: string;
  maxOutputTokens?: string;
  caps: Record<ModelCapabilityKey, boolean>;
  thinkingLevel?: string;
  protocol?: ModelProtocol;
}

export function emptyAddDraft(): AddModelDraft {
  return {
    modelId: '',
    displayName: '',
    contextLength: '',
    maxOutputTokens: '',
    caps: {
      tools: true,
      image: false,
      video: false,
      reasoning: false,
    },
  };
}

export interface ConfigDraft {
  displayName: string;
  contextLength: string;
  maxOutputTokens?: string;
  caps: Record<ModelCapabilityKey, boolean>;
  thinkingLevel?: string;
  protocol?: ModelProtocol;
  modalities?: {
    input: string[];
    output: string[];
  };
  thinkingEnabled?: boolean;
  thinkingMap?: Record<string, string>;
  pricing?: {
    currency: 'USD' | 'CNY';
    input?: string;
    output?: string;
    cacheRead?: string;
    cacheWrite?: string;
  };
}

export function applyMetaForModel(
  profileId: string,
  modelId: string,
  draft: ConfigDraft
): void {
  if (draft.displayName.trim()) {
    setModelDisplayName(profileId, modelId, draft.displayName.trim());
  }
  const n = parseInt(draft.contextLength.replace(/[^\d]/g, ''), 10);
  if (Number.isFinite(n) && n > 0) {
    setModelContextLength(profileId, modelId, n);
  }
  if (draft.maxOutputTokens) {
    const maxOut = parseInt(draft.maxOutputTokens.replace(/[^\d]/g, ''), 10);
    if (Number.isFinite(maxOut) && maxOut > 0) {
      setModelMaxOutputTokens(profileId, modelId, maxOut);
    }
  }
  for (const opt of MODEL_CAPABILITY_OPTIONS) {
    setModelCapability(
      profileId,
      modelId,
      opt.key,
      Boolean(draft.caps[opt.key])
    );
  }
  if (draft.thinkingLevel !== undefined) {
    setModelThinkingLevel(profileId, modelId, draft.thinkingLevel);
  }
  if (draft.protocol !== undefined) {
    setModelProtocol(profileId, modelId, draft.protocol);
  }

  // 1. 多模态矩阵 (Modalities)
  if (draft.modalities) {
    setModelModalities(profileId, modelId, draft.modalities);
  }

  // 2. 思考能力与拍平映射字典 (Thinking Map)
  if (draft.thinkingEnabled && draft.thinkingMap) {
    const cleanMap: Record<string, string> = {};
    for (const [k, v] of Object.entries(draft.thinkingMap)) {
      if (k.trim() && v !== undefined && String(v).trim()) {
        cleanMap[k.trim()] = String(v).trim();
      }
    }
    setModelThinking(
      profileId,
      modelId,
      Object.keys(cleanMap).length > 0 ? cleanMap : undefined
    );
  } else if (draft.thinkingEnabled === false) {
    setModelThinking(profileId, modelId, undefined);
  }

  // 3. 四维选填价格 (100% 选填，留空优雅静默)
  if (draft.pricing) {
    const inStr = draft.pricing.input?.trim();
    const outStr = draft.pricing.output?.trim();
    const crStr = draft.pricing.cacheRead?.trim();
    const cwStr = draft.pricing.cacheWrite?.trim();

    const inVal = inStr ? parseFloat(inStr) : undefined;
    const outVal = outStr ? parseFloat(outStr) : undefined;
    const crVal = crStr ? parseFloat(crStr) : undefined;
    const cwVal = cwStr ? parseFloat(cwStr) : undefined;

    const hasAnyPrice =
      (inVal !== undefined && !isNaN(inVal)) ||
      (outVal !== undefined && !isNaN(outVal)) ||
      (crVal !== undefined && !isNaN(crVal)) ||
      (cwVal !== undefined && !isNaN(cwVal));

    if (hasAnyPrice) {
      const priceSpec = {
        currency: draft.pricing.currency || 'USD',
        input: inVal !== undefined && !isNaN(inVal) ? inVal : undefined,
        output: outVal !== undefined && !isNaN(outVal) ? outVal : undefined,
        cacheRead: crVal !== undefined && !isNaN(crVal) ? crVal : undefined,
        cacheWrite: cwVal !== undefined && !isNaN(cwVal) ? cwVal : undefined,
      };
      setModelPricing(profileId, modelId, priceSpec);
      upsertPrice({
        model: modelId,
        currency: priceSpec.currency,
        inputPerMTok: priceSpec.input ?? 0,
        outputPerMTok: priceSpec.output ?? 0,
        cacheReadPerMTok: priceSpec.cacheRead,
        cacheWritePerMTok: priceSpec.cacheWrite,
      });
    } else {
      setModelPricing(profileId, modelId, undefined);
    }
  } else {
    // 若为字典收录模型且未配置单价，自动预填 YAML 真源中的标准牌价
    const known = findCatalogModel(modelId);
    if (known?.pricing) {
      const existingPrice = resolveModelPrice(modelId);
      if (!existingPrice) {
        upsertPrice({
          model: modelId,
          inputPerMTok: known.pricing.inputPerMTok ?? 0,
          outputPerMTok: known.pricing.outputPerMTok ?? 0,
          cacheReadPerMTok: known.pricing.cacheReadPerMTok,
          cacheWritePerMTok: known.pricing.cacheWritePerMTok,
          currency: 'USD',
          billingUnit: known.pricing.billingUnit,
          perImageCost: known.pricing.perImageCost,
        });
      }
    }
  }
}
