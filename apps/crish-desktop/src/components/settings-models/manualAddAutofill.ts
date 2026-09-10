import { findAutofillModel } from '../../services/modelsAutofillBaseline';
import { getLiveModel } from '../../api/modelsCatalogLive';
import { canonicalizeProtocol } from '../../api/modelsDraftMap';
import { STANDARD_THINKING_PRESET } from './ModelThinkingEditor';
import type { AddDraft } from './useModelProfilesState';

/**
 * 智能模型草稿预填计算（纯函数逻辑）：
 * 综合探针 LiveModel 与官方 Baseline 字典，计算规范化的 AddDraft。
 */
export function calculateAutofillDraft(
  id: string,
  providerVendor: string | undefined,
  prev: AddDraft,
  options?: { isSelection?: boolean }
): AddDraft {
  const live = getLiveModel(providerVendor ?? '', id);
  const autofill = findAutofillModel(id, providerVendor);

  const inputMods =
    live?.modalities?.input ??
    autofill?.modalities?.input ??
    prev.modalities?.input ??
    ['text', 'image'];
  const outputMods =
    live?.modalities?.output ??
    autofill?.modalities?.output ??
    prev.modalities?.output ??
    ['text'];
  const hasThinking = Boolean(
    (live?.thinking && Object.keys(live.thinking).length > 0) ||
    (autofill?.thinking && Object.keys(autofill.thinking).length > 0)
  );

  const isCustomName =
    !options?.isSelection &&
    Boolean(prev.displayName && prev.displayName !== prev.modelId);

  return {
    ...prev,
    modelId: id,
    displayName: isCustomName
      ? prev.displayName
      : live?.displayName ?? autofill?.displayName ?? id,
    contextLength:
      live?.contextWindow != null
        ? String(live.contextWindow)
        : autofill?.contextWindow != null
        ? String(autofill.contextWindow)
        : prev.contextLength,
    maxOutputTokens:
      live?.maxOutputTokens != null
        ? String(live.maxOutputTokens)
        : autofill?.maxOutputTokens != null
        ? String(autofill.maxOutputTokens)
        : prev.maxOutputTokens,
    modalities: {
      input: [...inputMods],
      output: [...outputMods],
    },
    caps: {
      tools: Boolean(live?.capabilities?.tools ?? prev.caps.tools ?? true),
      image: Boolean(live?.capabilities?.image ?? inputMods.includes('image')),
      video: Boolean(live?.capabilities?.video ?? inputMods.includes('video')),
      reasoning: Boolean(live?.capabilities?.reasoning ?? hasThinking),
    },
    thinkingEnabled: hasThinking,
    thinkingMap:
      live?.thinking ||
      autofill?.thinking ||
      prev.thinkingMap ||
      STANDARD_THINKING_PRESET,
    protocol: live?.protocol
      ? canonicalizeProtocol(live.protocol)
      : autofill?.protocol
      ? canonicalizeProtocol(autofill.protocol)
      : prev.protocol,
    pricing: live?.pricing
      ? {
          currency: live.pricing.currency === 'CNY' ? 'CNY' : 'USD',
          input: live.pricing.input != null ? String(live.pricing.input) : '',
          output: live.pricing.output != null ? String(live.pricing.output) : '',
          cacheRead: live.pricing.cacheRead != null ? String(live.pricing.cacheRead) : '',
          cacheWrite: live.pricing.cacheWrite != null ? String(live.pricing.cacheWrite) : '',
        }
      : autofill?.pricing
      ? {
          currency: autofill.pricing.currency === 'CNY' ? 'CNY' : 'USD',
          input: autofill.pricing.input != null ? String(autofill.pricing.input) : '',
          output: autofill.pricing.output != null ? String(autofill.pricing.output) : '',
          cacheRead: autofill.pricing.cacheRead != null ? String(autofill.pricing.cacheRead) : '',
          cacheWrite: autofill.pricing.cacheWrite != null ? String(autofill.pricing.cacheWrite) : '',
        }
      : prev.pricing,
  };
}
