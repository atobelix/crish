import { findAutofillModel } from '../../services/modelsAutofillBaseline';
import { getLiveModel } from '../../api/modelsCatalogLive';
import { normalizeProtocol } from '../../api/modelsNormalize';
import { STANDARD_THINKING_PRESET } from './ModelThinkingEditor';
import type { PricingConfig } from '../../api/modelsCatalogTypes';
import type { AddDraft } from './useModelProfilesState';

/** 字典/探针价格 → 草稿字符串形态，仅用于界面提示。 */
function toReferencePricing(pricing: PricingConfig): AddDraft['pricing'] {
  return {
    currency: pricing.currency === 'CNY' ? 'CNY' : 'USD',
    input: pricing.input != null ? String(pricing.input) : '',
    output: pricing.output != null ? String(pricing.output) : '',
    cacheRead: pricing.cacheRead != null ? String(pricing.cacheRead) : '',
    cacheWrite: pricing.cacheWrite != null ? String(pricing.cacheWrite) : '',
  };
}

/**
 * 智能模型草稿预填计算（纯函数逻辑）：
 * 综合探针 LiveModel 与官方 Baseline 字典，计算规范化的 AddDraft。
 * 只产出规范草稿字段（contextWindow / supportsTools / modalities / thinking），
 * 不发明能力默认，不携带旧 capabilities / contextLength 词表。
 *
 * 价格：字典/探针价一律只是**参考值**（供界面提示），本函数绝不置
 * `pricingExplicit`，因此它填出的 `pricing` 不会被 `addDraftToModelInput`
 * 当作「用户声明」写进统一树（用户裁决：字典只做参考）。
 */
export function calculateAutofillDraft(
  id: string,
  providerVendor: string | undefined,
  prev: AddDraft,
  options?: { isSelection?: boolean }
): AddDraft {
  const live = getLiveModel(providerVendor ?? '', id);
  const autofill = findAutofillModel(id, providerVendor);

  const inputMods = live?.modalities?.input ??
    autofill?.modalities?.input ??
    prev.modalities?.input ?? ['text'];
  const outputMods = live?.modalities?.output ??
    autofill?.modalities?.output ??
    prev.modalities?.output ?? ['text'];
  const hasThinking = Boolean(
    (live?.thinking && Object.keys(live.thinking).length > 0) ||
    (autofill?.thinking && Object.keys(autofill.thinking).length > 0)
  );

  const isCustomName =
    !options?.isSelection &&
    Boolean(prev.displayName && prev.displayName !== prev.modelId);

  // 参考价来源优先级：探针实测 > 官方字典 > 上一轮草稿。
  // 前两者是规范 PricingConfig（数值），后者已是草稿字符串形态，故分开处理。
  const sourcePricing = live?.pricing ?? autofill?.pricing;

  const next: AddDraft = {
    ...prev,
    modelId: id,
    displayName: isCustomName
      ? prev.displayName
      : (live?.displayName ?? autofill?.displayName ?? id),
    contextWindow:
      live?.contextWindow != null
        ? String(live.contextWindow)
        : autofill?.contextWindow != null
          ? String(autofill.contextWindow)
          : prev.contextWindow,
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
    supportsTools:
      live?.supportsTools ?? autofill?.supportsTools ?? prev.supportsTools,
    thinkingEnabled: hasThinking,
    thinkingMap:
      live?.thinking ||
      autofill?.thinking ||
      prev.thinkingMap ||
      STANDARD_THINKING_PRESET,
    protocol: live?.protocol
      ? normalizeProtocol(live.protocol)
      : autofill?.protocol
        ? normalizeProtocol(autofill.protocol)
        : prev.protocol,
  };
  // 参考价只作界面提示：探针/字典命中则覆盖为参考值，否则沿用上一轮草稿值；
  // 完全没有来源时不留 `pricing: undefined` 自有键（自有 undefined 键在补丁里
  // 意味着「明确清空」）。
  if (sourcePricing) next.pricing = toReferencePricing(sourcePricing);
  else if (!prev.pricing) delete next.pricing;
  // 预填绝不构成用户声明；显式清掉上一轮可能残留的标记。
  next.pricingExplicit = false;
  return next;
}
