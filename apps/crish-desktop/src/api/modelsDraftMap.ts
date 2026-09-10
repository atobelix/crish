/**
 * modelsDraftMap.ts —— 设置草稿 ↔ ModelSpec 纯映射（T2-1）
 *
 * 无 IO：不读浏览器存储、不写价表、不猜测窗口。
 * 写出只许 contextWindow、拍平 thinking、规范 protocol、规范价键。
 * 会话选档与旧默认档字段不进 patch。
 */

import { normalizeProtocol } from './modelsNormalize';
import type {
  ModelProtocol,
  ModelSpec,
  ModalityMatrix,
  PricingConfig,
  PricingCurrency,
  ProviderSpec,
  ThinkingMap,
} from './modelsCatalogTypes';

/** 设置抽屉草稿。表单窗口字段名仍是 contextLength；写出必须是 contextWindow。 */
export interface ModelConfigDraft {
  displayName?: string;
  contextLength?: string;
  maxOutputTokens?: string;
  caps?: {
    tools?: boolean;
    image?: boolean;
    video?: boolean;
    reasoning?: boolean;
  };
  /** 会话选档；禁止写入 ModelSpec / yaml */
  thinkingLevel?: string;
  /** 旧 LS 字段；禁止写入 ModelSpec / yaml */
  defaultThinkingLevel?: string;
  protocol?: ModelProtocol | string;
  modalities?: {
    input: string[];
    output: string[];
  };
  thinkingEnabled?: boolean;
  thinkingMap?: Record<string, string>;
  pricing?: {
    currency: PricingCurrency;
    input?: string;
    output?: string;
    cacheRead?: string;
    cacheWrite?: string;
  };
}

function parsePositiveInt(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw !== 'string') return undefined;
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return undefined;
  const n = parseInt(digits, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function parseOptionalPrice(raw: string | number | undefined): number | undefined {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : undefined;
  }
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** 空键、空值丢掉；清洗后空表视为缺省。 */
function cleanThinkingMap(
  map: Record<string, string> | undefined
): ThinkingMap | undefined {
  if (!map) return undefined;
  const clean: ThinkingMap = {};
  for (const [k, v] of Object.entries(map)) {
    if (k.trim() && v !== undefined && String(v).trim()) {
      clean[k.trim()] = String(v).trim();
    }
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

function pricingFromDraft(
  pricing: ModelConfigDraft['pricing']
): PricingConfig | undefined {
  if (!pricing) return undefined;
  const input = parseOptionalPrice(pricing.input);
  const output = parseOptionalPrice(pricing.output);
  const cacheRead = parseOptionalPrice(pricing.cacheRead);
  const cacheWrite = parseOptionalPrice(pricing.cacheWrite);
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  ) {
    return undefined;
  }
  const out: PricingConfig = {
    currency: pricing.currency === 'CNY' ? 'CNY' : 'USD',
  };
  if (input !== undefined) out.input = input;
  if (output !== undefined) out.output = output;
  if (cacheRead !== undefined) out.cacheRead = cacheRead;
  if (cacheWrite !== undefined) out.cacheWrite = cacheWrite;
  return out;
}

function copyModalities(raw: ModelConfigDraft['modalities']): ModalityMatrix | undefined {
  if (!raw) return undefined;
  return {
    input: Array.isArray(raw.input) ? [...raw.input] : [],
    output: Array.isArray(raw.output) ? [...raw.output] : [],
  };
}

function priceToDraftStr(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '';
  return String(n);
}

function stableThinking(thinking: ThinkingMap | undefined): Record<string, string> | null {
  if (!thinking || Object.keys(thinking).length === 0) return null;
  const keys = Object.keys(thinking).sort((a, b) => a.localeCompare(b));
  const out: Record<string, string> = {};
  for (const k of keys) out[k] = thinking[k]!;
  return out;
}

function stablePricing(pricing: PricingConfig | undefined): Record<string, unknown> | null {
  if (!pricing) return null;
  return {
    currency: pricing.currency ?? 'USD',
    input: pricing.input ?? null,
    output: pricing.output ?? null,
    cacheRead: pricing.cacheRead ?? null,
    cacheWrite: pricing.cacheWrite ?? null,
    unit: pricing.unit ?? null,
  };
}

/**
 * 草稿 → yaml / ModelSpec 规范字段。
 * 空价、思考关闭以显式 undefined 出现在返回值上，便于 updateModel spread 清掉旧值。
 */
export function draftToModelPatch(draft: ModelConfigDraft): Partial<ModelSpec> {
  const patch: Partial<ModelSpec> = {};

  if (typeof draft.displayName === 'string') {
    const t = draft.displayName.trim();
    patch.displayName = t ? t : undefined;
  }

  const contextWindow = parsePositiveInt(draft.contextLength);
  if (contextWindow !== undefined) {
    patch.contextWindow = contextWindow;
  }

  const maxOutputTokens = parsePositiveInt(draft.maxOutputTokens);
  if (maxOutputTokens !== undefined) {
    patch.maxOutputTokens = maxOutputTokens;
  }

  if (draft.caps) {
    patch.capabilities = { tools: Boolean(draft.caps.tools) };
  }

  if (draft.thinkingEnabled === true) {
    patch.thinking = cleanThinkingMap(draft.thinkingMap);
  } else if (draft.thinkingEnabled === false) {
    patch.thinking = undefined;
  }

  const protocol = normalizeProtocol(draft.protocol);
  if (protocol) {
    patch.protocol = protocol;
  }

  const modalities = copyModalities(draft.modalities);
  if (modalities) {
    patch.modalities = modalities;
  }

  if (draft.pricing) {
    patch.pricing = pricingFromDraft(draft.pricing);
  }

  return patch;
}

/**
 * store 节点 → 设置草稿（打开 / 保存后重开）。
 * provider 可成对传入，但不得把 provider.protocol 抄进草稿（否则保存会变成模型级覆盖）。
 */
export function modelToConfigDraft(
  model: ModelSpec,
  _provider?: ProviderSpec
): ModelConfigDraft {
  const thinkingMap =
    model.thinking && Object.keys(model.thinking).length > 0
      ? { ...model.thinking }
      : {};
  const thinkingEnabled = Object.keys(thinkingMap).length > 0;
  const input = model.modalities?.input;
  const pricing = model.pricing;

  const draft: ModelConfigDraft = {
    displayName: model.displayName ?? '',
    contextLength: model.contextWindow != null ? String(model.contextWindow) : '',
    maxOutputTokens:
      model.maxOutputTokens != null ? String(model.maxOutputTokens) : '',
    caps: {
      tools: Boolean(model.capabilities?.tools),
      image: Array.isArray(input) ? input.includes('image') : false,
      video: Array.isArray(input) ? input.includes('video') : false,
      reasoning: thinkingEnabled,
    },
    thinkingEnabled,
    thinkingMap,
    pricing: {
      currency: pricing?.currency === 'CNY' ? 'CNY' : 'USD',
      input: priceToDraftStr(pricing?.input),
      output: priceToDraftStr(pricing?.output),
      cacheRead: priceToDraftStr(pricing?.cacheRead),
      cacheWrite: priceToDraftStr(pricing?.cacheWrite),
    },
  };

  if (model.modalities) {
    draft.modalities = {
      input: [...(model.modalities.input ?? [])],
      output: [...(model.modalities.output ?? [])],
    };
  }

  const protocol = normalizeProtocol(model.protocol);
  if (protocol) draft.protocol = protocol;

  return draft;
}

/**
 * CT-01 稳定 JSON 签名。来源是 ModelSpec（store 节点），不是 LS meta。
 */
export function modelSpecRevision(model: ModelSpec): string {
  return JSON.stringify({
    displayName: model.displayName ?? '',
    contextWindow: model.contextWindow ?? null,
    maxOutputTokens: model.maxOutputTokens ?? null,
    enabled: model.enabled ?? true,
    protocol: normalizeProtocol(model.protocol) ?? null,
    thinking: stableThinking(model.thinking),
    modalities: model.modalities
      ? {
          input: model.modalities.input ?? [],
          output: model.modalities.output ?? [],
        }
      : null,
    pricing: stablePricing(model.pricing),
    tools: model.capabilities?.tools ?? false,
  });
}
