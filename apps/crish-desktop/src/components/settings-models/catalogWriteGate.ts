/**
 * 设置页写入口共用闸门：ensureLsImported → ensureLoaded → 无则建供应商壳。
 * 不写 apiKey。缺 protocol 写出 SSOT 默认协议（M15）。运行时不按 URL 猜协议。
 */
import { ensureLsImported } from '../../api/modelsLsImport';
import { draftToModelPatch } from '../../api/modelsDraftMap';
import type { AddModelDraft } from './modelsIpcHelpers';
import {
  DEFAULT_PROTOCOL,
  PROTOCOLS,
  PROTOCOL_LABELS,
  normalizeProtocol,
} from '../../api/modelsNormalize';
import {
  modelsCatalogStore,
  selectProvider,
} from '../../api/modelsCatalogStore';
import type { ModelSpec, ModelProtocol } from '../../api/modelsCatalogTypes';

/** 缺省协议别名（SSOT 恒为 modelsNormalize.DEFAULT_PROTOCOL）。 */
export const DEFAULT_YAML_PROTOCOL: ModelProtocol = DEFAULT_PROTOCOL;

/** 协议下拉：value 与 label 一律从协议 SSOT（PROTOCOLS / PROTOCOL_LABELS）派生。 */
export const YAML_PROTOCOL_SELECT_OPTIONS = PROTOCOLS.map((p) => ({
  id: p,
  value: p,
  label: PROTOCOL_LABELS[p],
}));

export function toYamlProtocol(
  raw: string | undefined | null
): ModelProtocol | undefined {
  return normalizeProtocol(raw);
}

/** 供应商保存：缺 protocol 写出 SSOT 默认协议（M15）。 */
export function protocolForProviderWrite(
  raw: string | undefined | null
): ModelProtocol {
  return normalizeProtocol(raw) ?? DEFAULT_PROTOCOL;
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
  const id = args.providerId.trim();
  if (!id) return { ok: false, error: '供应商 id 为空' };
  if (selectProvider(id)) return { ok: true };
  return modelsCatalogStore.addProvider(id, {
    displayName: args.displayName,
    baseUrl: args.baseUrl,
    protocol: protocolForProviderWrite(args.protocol),
    stream: true,
    enabled: true,
    models: [],
  });
}

export async function defaultLocalMutation<T>(
  fn: () => Promise<T> | T
): Promise<T> {
  return await fn();
}

/** 手填草稿 → addModel 输入。不写 thinking 空对象、不写 apiKey；映射只产出规范字段。 */
export function addDraftToModelInput(
  id: string,
  draft: AddModelDraft
): Partial<ModelSpec> & { id: string } {
  const patch = draftToModelPatch(draft);
  return { id, ...patch };
}
