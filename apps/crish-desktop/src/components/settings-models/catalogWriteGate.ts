/**
 * 设置页写入口共用闸门：ensureLsImported → ensureLoaded → 无则建供应商壳。
 * 不写 apiKey。缺 protocol 写出 openai/chat（M15）。运行时不按 URL 猜协议。
 */
import { ensureLsImported } from '../../api/modelsLsImport';
import {
  canonicalizeProtocol,
  draftToModelPatch,
} from '../../api/modelsDraftMap';
import {
  modelsCatalogStore,
  selectProvider,
} from '../../api/modelsCatalogStore';
import type { ModelSpec, ModelProtocol } from '../../api/modelsCatalogTypes';

export const DEFAULT_YAML_PROTOCOL: ModelProtocol = 'openai/chat';

export const YAML_PROTOCOL_SELECT_OPTIONS = [
  {
    id: 'openai/chat',
    value: 'openai/chat',
    label: 'OpenAI Chat (/v1/chat/completions)',
  },
  {
    id: 'openai/responses',
    value: 'openai/responses',
    label: 'OpenAI Responses (/responses)',
  },
  {
    id: 'anthropic/messages',
    value: 'anthropic/messages',
    label: 'Anthropic Messages (/v1/messages)',
  },
  // 用户裁决：通信协议只保留默认三种（openai/chat、openai/responses、
  // anthropic/messages）。google/generate-content 不再出现在设置选择器
  //（读边界仍认该值，仅不提供新建入口）。
] as const;

export function toYamlProtocol(
  raw: string | undefined | null
): ModelProtocol | undefined {
  return canonicalizeProtocol(raw);
}

/** 供应商保存：缺 protocol 写出 openai/chat（M15）。 */
export function protocolForProviderWrite(
  raw: string | undefined | null
): ModelProtocol {
  return canonicalizeProtocol(raw) ?? DEFAULT_YAML_PROTOCOL;
}

export async function prepareCatalogWrite(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  try {
    const imported = await ensureLsImported();
    if (!imported.ok) {
      return { ok: false, error: imported.error || 'LS 导入失败' };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const loaded = await modelsCatalogStore.ensureLoaded();
  if (!loaded) {
    const err = modelsCatalogStore.getState().lastError?.message;
    return { ok: false, error: err || '模型目录尚未加载' };
  }
  return { ok: true };
}

export async function ensureProviderShell(args: {
  providerId: string;
  displayName: string;
  baseUrl: string;
  protocol?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const ready = await prepareCatalogWrite();
  if (!ready.ok) return ready;
  const id = args.providerId.trim().toLowerCase();
  if (!id) return { ok: false, error: '供应商 id 为空' };
  if (selectProvider(id)) return { ok: true };
  return modelsCatalogStore.addProvider(id, {
    displayName: args.displayName,
    baseUrl: args.baseUrl,
    protocol: protocolForProviderWrite(args.protocol),
    models: [],
  });
}

export async function defaultLocalMutation<T>(
  fn: () => Promise<T> | T
): Promise<T> {
  return await fn();
}

/** 手填草稿 → addModel 输入。不写 thinking 空对象、不写 apiKey。 */
export function addDraftToModelInput(
  id: string,
  draft: {
    displayName: string;
    contextLength: string;
    maxOutputTokens?: string;
    caps: {
      tools: boolean;
      image: boolean;
      video: boolean;
      reasoning: boolean;
    };
    protocol?: string;
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
): Partial<ModelSpec> & { id: string } {
  const input = draft.modalities?.input ? [...draft.modalities.input] : ['text'];
  if (draft.caps.image && !input.includes('image')) input.push('image');
  if (draft.caps.video && !input.includes('video')) input.push('video');
  const output = draft.modalities?.output ? [...draft.modalities.output] : ['text'];

  const patch = draftToModelPatch({
    displayName: draft.displayName,
    contextLength: draft.contextLength,
    maxOutputTokens: draft.maxOutputTokens,
    caps: draft.caps,
    protocol: draft.protocol,
    modalities: { input, output },
    thinkingEnabled: draft.thinkingEnabled,
    thinkingMap: draft.thinkingMap,
    pricing: draft.pricing,
  });
  return {
    id,
    ...patch,
    capabilities: {
      tools: Boolean(draft.caps.tools),
      image: Boolean(draft.caps.image || input.includes('image')),
      video: Boolean(draft.caps.video || input.includes('video')),
      reasoning: Boolean(draft.caps.reasoning || draft.thinkingEnabled),
    },
  };
}
