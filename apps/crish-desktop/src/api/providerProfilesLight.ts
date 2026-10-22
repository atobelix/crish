/**
 * providerProfilesLight.ts — 轻量服务商与模型探测（冷启动零副作用 · D9-B DEL-5）。
 *
 * 仅包含冷启动判定（新手向导门闩、首屏就绪检查）所需的纯函数与轻量 localStorage 探测，
 * 绝不静态引入 catalog.json / rustProfileStore / 重型元数据，切断 entry → catalog 静态边。
 */

/** 供应商是否具备可用密钥标记（纯，不读 LS） */
export function profileHasKey(
  p: { hasKey?: boolean; apiKey?: string } | null | undefined
): boolean {
  if (!p) return false;
  return Boolean(
    p.hasKey || (typeof p.apiKey === 'string' && p.apiKey.trim().length > 0)
  );
}

/**
 * 轻量判定任一供应商是否已配密钥。
 * 只读 localStorage `crish_profiles` 键，不触发全量 loadProfiles 校验与迁移。
 */
export function anyProfileHasKey(): boolean {
  try {
    const raw =
      localStorage.getItem('crish_provider_profiles_v1') ||
      localStorage.getItem('crish_profiles');
    if (!raw) return false;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return false;
    return arr.some((p) => profileHasKey(p));
  } catch {
    return false;
  }
}

/**
 * 模型 id 列表规范化（纯）：trim、丢弃空项、保序去重。
 * 不发明演示 id；非法入参 → []。
 */
export function normalizeModelIds(models: unknown): string[] {
  if (!Array.isArray(models)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of models) {
    if (raw == null) continue;
    const m = String(raw).trim();
    if (!m) continue;
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

/** 获取活动供应商 ID（纯读 localStorage） */
export function getActiveProfileId(): string | null {
  try {
    return localStorage.getItem('crish_active_profile_id');
  } catch {
    return null;
  }
}

/** 获取活动模型 ID（纯读 localStorage） */
export function getActiveModelId(): string | null {
  try {
    return localStorage.getItem('crish_active_model_id');
  } catch {
    return null;
  }
}

/** 未指定时的默认协议（纯常量，与 modelsNormalize.DEFAULT_PROTOCOL 保持一致） */
export const DEFAULT_PROTOCOL = 'openai/chat';

export type LiveModelGetter = (
  providerId: string,
  modelId: string
) => { contextWindow?: number } | undefined;

export type LiveThinkingHandoffResolver = (
  providerId: string,
  modelId: string,
  selectedTitle: string | null
) => {
  supported: boolean;
  selectedTitle?: string | null;
  selectedWire?: string | null;
};

let _liveModelGetter: LiveModelGetter | null = null;
let _thinkingHandoffResolver: LiveThinkingHandoffResolver | null = null;

/** 注入 catalog 运行时解析器（D9-B：断开 transport ↔ catalog 静态边） */
export function registerLiveCatalogResolvers(resolvers: {
  getLiveModel?: LiveModelGetter;
  resolveThinkingHandoffSafe?: LiveThinkingHandoffResolver;
}): void {
  if (resolvers.getLiveModel) _liveModelGetter = resolvers.getLiveModel;
  if (resolvers.resolveThinkingHandoffSafe)
    _thinkingHandoffResolver = resolvers.resolveThinkingHandoffSafe;
}

export function getLiveModelFromRegistry(
  providerId: string,
  modelId: string
): { contextWindow?: number } | undefined {
  return _liveModelGetter?.(providerId, modelId);
}

export function resolveThinkingHandoffFromRegistry(
  providerId: string,
  modelId: string,
  selectedTitle: string | null
): {
  supported: boolean;
  selectedTitle?: string | null;
  selectedWire?: string | null;
} | null {
  return _thinkingHandoffResolver
    ? _thinkingHandoffResolver(providerId, modelId, selectedTitle)
    : null;
}
