/**
 * Engine configuration — real daemon get-status / update-config.
 * Also keeps a local recent-models list for the chat picker.
 */

import { getDesktopDaemonClient } from './daemonClient';
import { logInternalError } from './userFacingErrors';

const RECENT_MODELS_KEY = 'crish_recent_models';
const MAX_RECENT = 12;

export type EngineStatus = {
  ok: boolean;
  model?: string;
  baseUrl?: string;
  hasApiKey?: boolean;
  credentialMode?: string;
  raw?: Record<string, unknown>;
  error?: string;
};

function pickNested(obj: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function loadRecentModels(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_MODELS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function pushRecentModel(model: string): string[] {
  const m = model.trim();
  if (!m) return loadRecentModels();
  const next = [m, ...loadRecentModels().filter((x) => x !== m)].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

export async function fetchEngineStatus(): Promise<EngineStatus> {
  const client = getDesktopDaemonClient();
  client.startKeepAlive();
  try {
    const ready = await client.waitUntilConnected(12_000);
    if (!ready) return { ok: false, error: 'not_connected' };

    const res = (await client.request({ type: 'get-status' }, 'status-response', 8_000)) as Record<
      string,
      unknown
    >;

    const provider =
      (pickNested(res, ['provider']) as Record<string, unknown> | undefined) ||
      (pickNested(res, ['config']) as Record<string, unknown> | undefined) ||
      {};

    // Common shapes from daemon status
    const nestedProvider =
      (pickNested(res, ['providerStatus']) as Record<string, unknown> | undefined) ||
      (pickNested(res, ['lifecycle', 'providerStatus']) as Record<string, unknown> | undefined);

    const src = { ...provider, ...(nestedProvider || {}) };

    const apiKeyInfo =
      (pickNested(res, ['provider', 'apiKey']) as Record<string, unknown> | undefined) ||
      (pickNested(src, ['apiKey']) as Record<string, unknown> | undefined) ||
      (pickNested(res, ['apiKey']) as Record<string, unknown> | undefined);

    const hasApiKey =
      typeof apiKeyInfo?.hasApiKey === 'boolean'
        ? apiKeyInfo.hasApiKey
        : typeof src.hasApiKey === 'boolean'
          ? (src.hasApiKey as boolean)
          : Boolean(pickNested(res, ['hasApiKey']));

    const model =
      (typeof src.model === 'string' && src.model) ||
      (typeof provider.model === 'string' && provider.model) ||
      (typeof res.model === 'string' && res.model) ||
      undefined;

    const baseUrl =
      (typeof src.baseUrl === 'string' && src.baseUrl) ||
      (typeof provider.baseUrl === 'string' && provider.baseUrl) ||
      (typeof res.baseUrl === 'string' && res.baseUrl) ||
      undefined;

    const credentialMode =
      (typeof src.credentialMode === 'string' && src.credentialMode) ||
      (typeof provider.credentialMode === 'string' && provider.credentialMode) ||
      undefined;

    if (model) pushRecentModel(model);

    return {
      ok: true,
      model,
      baseUrl,
      hasApiKey,
      credentialMode,
      raw: res,
    };
  } catch (e) {
    logInternalError('fetchEngineStatus', e);
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export type EngineConfigUpdate = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  credentialMode?: string;
  endpoint?: string;
  stream?: boolean;
};

export async function updateEngineConfig(
  update: EngineConfigUpdate,
): Promise<{ ok: boolean; error?: string }> {
  const client = getDesktopDaemonClient();
  try {
    const ready = await client.waitUntilConnected(12_000);
    if (!ready) return { ok: false, error: 'not_connected' };

    const payload: Record<string, unknown> = { type: 'update-config' };
    for (const [k, v] of Object.entries(update)) {
      if (v !== undefined && v !== '') payload[k] = v;
    }

    await client.request(payload, ['config-updated', 'status-response', 'error'], 12_000);
    if (typeof update.model === 'string' && update.model.trim()) {
      pushRecentModel(update.model.trim());
    }
    return { ok: true };
  } catch (e) {
    logInternalError('updateEngineConfig', e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Models shown in chat picker: recent + current engine model. */
export function modelsForPicker(current?: string): string[] {
  const list = loadRecentModels();
  if (current && !list.includes(current)) return [current, ...list];
  return list;
}
