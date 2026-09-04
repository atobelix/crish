import {
  type ModelCapabilityKey,
  MODEL_CAPABILITY_OPTIONS,
  setModelCapability,
  setModelContextLength,
  setModelMaxOutputTokens,
  setModelDisplayName,
  setModelThinkingLevel,
  setModelProtocol,
} from '../../api/modelCatalog';
import { findCatalogModel } from '../../api/modelsCatalogStore';
import { resolveModelPrice, upsertPrice } from '../../api/pricingStore';

export interface AddModelDraft {
  modelId: string;
  displayName: string;
  contextLength: string;
  maxOutputTokens?: string;
  caps: Record<ModelCapabilityKey, boolean>;
  thinkingLevel?: string;
  protocol?: 'openai/chat' | 'openai/responses' | 'anthropic/messages';
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
  protocol?: 'openai/chat' | 'openai/responses' | 'anthropic/messages';
}

export function applyMetaForModel(
  profileId: string,
  modelId: string,
  draft: {
    displayName: string;
    contextLength: string;
    maxOutputTokens?: string;
    caps: Record<ModelCapabilityKey, boolean>;
    thinkingLevel?: string;
    protocol?: 'openai/chat' | 'openai/responses' | 'anthropic/messages';
  }
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
