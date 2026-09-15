/**
 * Engine config I/O 域（从 engineConfig 拆出）：localStorage + daemon 通道。
 *
 * - localStorage：recent-models 读写
 * - daemon I/O：fetchEngineStatus / loadEngineConfig / updateEngineConfig（C3.1 transport 路径）
 */
import { getTransport } from './transport';
import { logInternalError } from './userFacingErrors';
import type { EngineConfigUpdate, EngineStatus } from './engineConfigTypes';
import { modelsCatalogStore } from './modelsCatalogStore';
import {
  buildUpdateConfigPayload,
  isEmptyEngineConfigUpdate,
  mergeModelsForPicker,
  normalizeEngineConfigText,
  normalizeEngineConfigUpdate,
  normalizeEngineModelId,
  normalizeRecentModels,
  parseEngineStatusFromRaw,
  parseRecentModelKey,
  recentModelKey,
} from './engineConfigHelpers';

const RECENT_MODELS_KEY = 'crish_recent_models';
const MAX_RECENT = 12;

/**
 * 最近使用模型：**身份 = (providerId, modelId) 二元组**（裁决 ③）。
 * 存储形状为**本仓唯一身份键** `modelRefKey`（JSON 二元组字符串，如
 * `["ollama","ornith"]`）的字符串数组——**不是** `providerId::modelId` 模板拼接，
 * 也不得引入第三种连接格式（D5 身份键防线）。
 * 裸 modelId 一律不得参与身份解析——同名模型可同时存在于多个供应商。
 */
function readStoredRecent(): unknown[] {
  try {
    const raw = localStorage.getItem(RECENT_MODELS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeStoredRecent(keys: string[]): void {
  try {
    localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(keys));
  } catch {
    /* ignore */
  }
}

/**
 * 统一树中唯一持有该 modelId 的供应商 id；0 个或 >1 个 → null。
 * 歧义/未知一律不猜（裁决 ③），树未加载同样返回 null。
 */
function resolveUniqueProviderId(modelId: string): string | null {
  const state = modelsCatalogStore.getState();
  if (!state.loaded) return null;
  let found: string | null = null;
  for (const entry of state.modelIndex.values()) {
    if (entry.model.id !== modelId) continue;
    if (found !== null && found !== entry.providerId) return null;
    found = entry.providerId;
  }
  return found;
}

/**
 * 读取最近使用模型键（`modelRefKey` = JSON 二元组）。
 *
 * 存量裸 id 的一次性幂等迁移：能由统一树解析出唯一供应商 → 迁移为二元组；
 * 歧义/未知 → 丢弃（不得猜）。树未加载时不改写存储（保留原值待下次迁移），
 * 但裸 id 不进入返回列表——裸 id 永不参与身份解析。
 */
export function loadRecentModels(): string[] {
  const stored = readStoredRecent();
  const treeReady = modelsCatalogStore.getState().loaded;
  const out: string[] = [];
  let changed = false;
  for (const item of stored) {
    const ref = parseRecentModelKey(item);
    if (ref) {
      out.push(recentModelKey(ref.providerId, ref.modelId));
      continue;
    }
    const bare = normalizeEngineModelId(item);
    if (!bare) {
      changed = true;
      continue;
    }
    if (!treeReady) continue;
    const providerId = resolveUniqueProviderId(bare);
    if (providerId) {
      out.push(recentModelKey(providerId, bare));
    }
    changed = true;
  }
  const deduped = [...new Set(out)].slice(0, MAX_RECENT);
  if (changed) writeStoredRecent(deduped);
  return deduped;
}

/**
 * 记录一次最近使用（`modelRefKey` = JSON 二元组）。
 * 显式 providerId 优先；缺省时由统一树解析唯一供应商；无法确定身份 → 不写入
 * （裸 modelId 永不落库）。
 */
export function pushRecentModel(
  model: string,
  providerId?: string | null,
): string[] {
  const m = normalizeEngineModelId(model);
  if (!m) return loadRecentModels();
  const pid =
    normalizeEngineConfigText(providerId ?? '') || resolveUniqueProviderId(m);
  if (!pid) return loadRecentModels();
  const key = recentModelKey(pid, m);
  const next = [
    key,
    ...loadRecentModels().filter((x) => x !== key),
  ].slice(0, MAX_RECENT);
  writeStoredRecent(next);
  return next;
}

/**
 * 引擎状态读取（C3.1 transport 路径）：
 * - transport.waitUntilConnected（core_get_status 轮询）判「核心已初始化」；
 * - 就绪后 request('core_get_status') 取引擎状态原始 JSON。
 * 不再有 WS keep-alive / hasEverConnected 语义：未就绪 → ok:false（显式离线）。
 */
export async function fetchEngineStatus(): Promise<EngineStatus> {
  const transport = getTransport();
  try {
    const ready = await transport.waitUntilConnected(12_000);
    if (!ready) {
      return { ok: false, connected: false, error: 'not_connected' };
    }

    const res = (await transport.request<Record<string, unknown>>(
      'core_get_status',
      {},
      { timeoutMs: 8_000 }
    )) as Record<string, unknown>;

    // 不在 get-status 时写入 recent：避免引擎演示默认（如 mimo）污染本机最近列表
    // recent 仅由用户主动 activate / update-config 写入
    const parsed = parseEngineStatusFromRaw(res);
    return {
      ...parsed,
      ok: true,
      connected: true,
      reconnecting: false,
      raw: res,
    };
  } catch (e) {
    logInternalError('fetchEngineStatus', e);
    return {
      ok: false,
      connected: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * 读取引擎配置脱敏快照（config_get，T-F 06 T2.6 接线：配置族只写不读的
 * P2-8 补读面）。经 transport.request('config_get') 同一通道（与 config_update
 * 对称）；命令缺失 / 报错 → logInternalError + null（不抛，只补读不重建状态流）。
 */
export async function loadEngineConfig(): Promise<Record<string, unknown> | null> {
  const transport = getTransport();
  try {
    const ready = await transport.waitUntilConnected(12_000);
    if (!ready) {
      logInternalError('loadEngineConfig', 'not_connected');
      return null;
    }
    const res = (await transport.request<Record<string, unknown>>(
      'config_get',
      {},
      { timeoutMs: 8_000 },
    )) as Record<string, unknown>;
    return res && typeof res === 'object' ? res : null;
  } catch (e) {
    logInternalError('loadEngineConfig', e);
    return null;
  }
}

export async function updateEngineConfig(
  update: EngineConfigUpdate,
): Promise<{ ok: boolean; error?: string }> {
  const transport = getTransport();
  try {
    const ready = await transport.waitUntilConnected(12_000);
    if (!ready) return { ok: false, error: 'not_connected' };

    const normalized = normalizeEngineConfigUpdate(update);
    if (isEmptyEngineConfigUpdate(normalized)) {
      // 无可下发字段：视为成功 no-op（避免空 config_update 打核心）
      return { ok: true };
    }

    const payload = buildUpdateConfigPayload(normalized);
    const { type: _type, ...rest } = payload;
    await transport.request('config_update', rest, { timeoutMs: 12_000 });
    if (typeof normalized.model === 'string' && normalized.model) {
      pushRecentModel(normalized.model);
    }
    return { ok: true };
  } catch (e) {
    logInternalError('updateEngineConfig', e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Models shown in chat picker: recent + current engine model. */
export function modelsForPicker(current?: string): string[] {
  // 最近使用为二元组键；picker 展示面只取 modelId 分量
  const recentIds = loadRecentModels().map(
    (key) => parseRecentModelKey(key)?.modelId ?? key,
  );
  return mergeModelsForPicker(recentIds, current);
}
