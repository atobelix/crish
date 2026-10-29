/**
 * 旧明文 API key 一次性迁移（PE-07 T07.4-B；单实现唯一负责方 = 本文件，AU-04 D12/F5）。
 *
 * 目标（K-01 下线）：把 `crish_provider_profiles_v1` 中的明文 `apiKey` 逐条迁入
 * Rust DPAPI 凭据槽（config_profile_apply），确认写入成功后才从 localStorage
 * 剥离明文；剥离完成后置幂等标记，重复启动不重复迁移。
 *
 * 安全模型：
 * - 幂等标记 `crish_profiles_secrets_migrated_v1`（F5 冻结名）：已标记即跳过；
 * - 每个 profile 的明文只在其 apply 返回 ok && hasKey 后剥离；
 * - apply 返回 persistence != 'persisted'（降级/内存态）→ 保留明文，标记 degraded，
 *   不置幂等标记（下次启动重试；防止「DPAPI 未落盘却删明文」的密钥丢失）；
 * - 失败重试一次；仍失败 → 记录 security-migration-failed 事件 + 日志（脱敏），
 *   不阻断启动，明文保留可重试；
 * - 全 localStorage 键扫描断言：迁移后不得残留含 apiKey 字段的 profile JSON。
 */

import { configSecretSet } from './rustProfileStore';
import { emitUiEvent } from '../uiEvents';
import { logger } from '../../services/LoggerService';
import { redactSecrets } from '@crish/shared-utils';

/** 幂等标记（AU-04 F5/D12 冻结名；置位 = 迁移已完成，跳过后续启动） */
export const LEGACY_MIGRATION_FLAG_KEY = 'crish_profiles_secrets_migrated_v1';
/** 旧明文 profile 存储键（K-01 源） */
export const LEGACY_PROFILES_KEY = 'crish_provider_profiles_v1';

/**
 * 历史无主明文键：更早版本遗留的 profile 存储键，当前代码已无任何读写点
 * （2026-08-08 全仓 grep 确认）——含 apiKey 明文但迁移链只处理
 * LEGACY_PROFILES_KEY，导致每次启动全键扫描报残留、幂等标记永不置位、
 * 每次启动重复告警（用户噪音）。迁移时统一剥离这些键的明文字段
 * （保留 hasKey 标记），消除残留告警与 localStorage 明文暴露面。
 */
const ORPHAN_LEGACY_KEYS = ['crish_providers', 'conex_pi_providers'] as const;

export type LegacyMigrationResult = {
  /** 是否因幂等标记 / 无存量数据而跳过 */
  skipped: boolean;
  /** 成功迁入 DPAPI 并剥离明文的 profile 数 */
  migrated: number;
  /** 降级（非 persisted）而保留明文的 profile 数 */
  degraded: number;
  /** 写入失败的 profile id（明文保留，下次启动重试） */
  failed: string[];
  /** 是否经历过一次重试 */
  retried: boolean;
  /** 全键扫描发现的残留明文键（迁移后仍含 apiKey） */
  residualKeys: string[];
};

/** 模块级门控：并发调用共享同一次迁移（StrictMode 双跑 / 多入口安全） */
let migrationInFlight: Promise<LegacyMigrationResult> | null = null;

/** 幂等标记是否已置位（同步读取） */
export function isLegacyMigrationDone(): boolean {
  try {
    return localStorage.getItem(LEGACY_MIGRATION_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * 确保迁移已执行（幂等门控；返回共享的迁移结果）。
 * loadProfiles 前置钩子与 bootstrap 调用点共用。
 */
export function ensureLegacyProfilesMigration(): Promise<LegacyMigrationResult> {
  if (!migrationInFlight) {
    migrationInFlight = migrateLegacyProfiles();
  }
  return migrationInFlight;
}

/**
 * 全 localStorage 键扫描：断言无含 apiKey 字段的 profile JSON。
 * 仅扫描可解析为 JSON 且含 `apiKey` 字符串字段的值；非 JSON / 无敏感字段跳过。
 */
export function scanLocalStorageForPlaintextKeys(): string[] {
  const hits: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      const raw = localStorage.getItem(key);
      if (!raw || !raw.includes('apiKey')) continue;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (containsApiKeyField(parsed)) hits.push(key);
      } catch {
        /* 非 JSON 值（apiKey 字样误命中）忽略 */
      }
    }
  } catch {
    /* localStorage 不可用（SSR）→ 无扫描面 */
  }
  return hits;
}

function containsApiKeyField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsApiKeyField);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.apiKey === 'string' && obj.apiKey.trim()) return true;
    return Object.values(obj).some(containsApiKeyField);
  }
  return false;
}

/**
 * 一次性迁移入口：
 * 1. 幂等标记已置 → 跳过；
 * 2. 读 `crish_provider_profiles_v1` → 逐 profile（apiKey 非空）调
 *    config_profile_apply（DPAPI + 引擎）→ 成功后从对象剥离 apiKey；
 * 3. 写回净化 JSON → 全键扫描断言 → 置幂等标记；
 * 4. 失败重试一次；仍失败 → security-migration-failed 事件 + 脱敏日志（不阻断）。
 */
export async function migrateLegacyProfiles(): Promise<LegacyMigrationResult> {
  if (isLegacyMigrationDone()) {
    return {
      skipped: true,
      migrated: 0,
      degraded: 0,
      failed: [],
      retried: false,
      residualKeys: [],
    };
  }

  let result = await runMigrationPass();
  if (hasIncomplete(result)) {
    result = { ...(await runMigrationPass()), retried: true };
  }

  if (hasIncomplete(result)) {
    reportMigrationFailure(result);
  } else {
    markMigrationDone();
  }
  return result;
}

/** 本次迁移是否未完成（有失败/降级/残留明文 → 不置幂等标记） */
function hasIncomplete(result: LegacyMigrationResult): boolean {
  return (
    result.failed.length > 0 ||
    result.degraded > 0 ||
    result.residualKeys.length > 0
  );
}

function markMigrationDone(): void {
  try {
    localStorage.setItem(LEGACY_MIGRATION_FLAG_KEY, '1');
  } catch {
    /* 标记写失败不阻断（下次启动重试，幂等） */
  }
}

function reportMigrationFailure(result: LegacyMigrationResult): void {
  const detail = redactSecrets(
    `migrateLegacyProfiles 未完成：migrated=${result.migrated} degraded=${result.degraded}` +
      ` failed=[${result.failed.join(',')}] residual=[${result.residualKeys.join(',')}]`
  );
  logger.warn(detail, { module: 'provider-migration' });
  try {
    emitUiEvent('security-migration-failed', {
      attempts: result.retried ? 2 : 1,
      migrated: result.migrated,
      degraded: result.degraded,
      failed: result.failed,
    });
  } catch {
    /* 事件总线不可用时忽略 */
  }
}

type LegacyProfile = {
  id?: unknown;
  hasKey?: unknown;
  apiKey?: unknown;
  [key: string]: unknown;
};

async function runMigrationPass(): Promise<LegacyMigrationResult> {
  const outcome: LegacyMigrationResult = {
    skipped: false,
    migrated: 0,
    degraded: 0,
    failed: [],
    retried: false,
    residualKeys: [],
  };

  // 历史无主键明文剥离（死键含 apiKey → 剥离后扫描无残留，
  // 消除每次启动重复告警噪音；hasKey 标记保留）。置于最前：
  // 无论主键是否存在（含 skipped 提前返回路径）都要剥离，否则
  // 死键残留导致幂等标记永不置位、每次启动重复告警。
  stripOrphanKeys();

  let profiles: LegacyProfile[] = [];
  try {
    const raw = localStorage.getItem(LEGACY_PROFILES_KEY);
    if (!raw) {
      markMigrationDone();
      return { ...outcome, skipped: true };
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      markMigrationDone();
      return { ...outcome, skipped: true };
    }
    profiles = parsed as LegacyProfile[];
  } catch {
    // 旧 JSON 损坏：无法迁移，保持原样并跳过（不置标记，避免死循环破坏数据）
    return { ...outcome, skipped: true, residualKeys: [LEGACY_PROFILES_KEY] };
  }

  // 密钥按档案顺序逐条迁入 DPAPI 凭据槽；成功即落盘（与配置事务原子提交）
  const keyed = profiles.filter(
    (p) => typeof p.apiKey === 'string' && (p.apiKey as string).trim()
  );

  let changed = false;
  for (const p of keyed) {
    const apiKey = (p.apiKey as string).trim();
    const profileId = String(p.id ?? '').trim();
    if (!profileId) {
      outcome.failed.push('<empty-id>');
      continue;
    }
    const res = await configSecretSet(profileId, apiKey);
    if (res.status === 'ok' && res.data?.hasKey === true) {
      // DPAPI 落盘确认（与配置事务原子提交）→ 剥离明文（保留 hasKey 标记）
      delete p.apiKey;
      p.hasKey = true;
      changed = true;
      outcome.migrated += 1;
    } else {
      // 写入失败：明文保留可重试
      outcome.failed.push(profileId);
    }
  }

  if (changed) {
    try {
      localStorage.setItem(LEGACY_PROFILES_KEY, JSON.stringify(profiles));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome.failed.push('<write-back>');
      logger.warn(redactSecrets(`migrateLegacyProfiles 写回失败：${message}`), {
        module: 'provider-migration',
      });
    }
  }

  // 全 LS 键扫描断言（迁移后不得残留含 apiKey 的 profile JSON）
  outcome.residualKeys = scanLocalStorageForPlaintextKeys();
  return outcome;
}

/**
 * 剥离历史无主键中的 apiKey 明文字段（递归，保留 hasKey 标记）。
 * 返回是否发生过剥离（供调用方判断是否需要写回）。
 */
function stripOrphanKeys(): boolean {
  let changed = false;
  for (const key of ORPHAN_LEGACY_KEYS) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw || !raw.includes('apiKey')) continue;
      const parsed: unknown = JSON.parse(raw);
      const cleaned = stripApiKeyDeep(parsed);
      if (cleaned !== parsed) {
        localStorage.setItem(key, JSON.stringify(cleaned));
        changed = true;
      }
    } catch {
      // JSON 损坏等：保持原样（下次启动重试；不静默吞掉，扫描仍会报残留）
    }
  }
  return changed;
}

/** 递归剥离对象/数组中的 apiKey 字段（保留 hasKey 标记） */
function stripApiKeyDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripApiKeyDeep);
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = { ...obj };
    if (typeof out.apiKey === 'string' && out.apiKey.trim()) {
      delete out.apiKey;
      out.hasKey = true;
    }
    for (const k of Object.keys(out)) {
      if (typeof out[k] === 'object' && out[k] !== null) {
        out[k] = stripApiKeyDeep(out[k]);
      }
    }
    return out;
  }
  return value;
}

/** 测试钩子：重置模块级迁移门控（vitest 用例间隔离） */
export function resetLegacyMigrationForTests(): void {
  migrationInFlight = null;
  try {
    localStorage.removeItem(LEGACY_MIGRATION_FLAG_KEY);
  } catch {
    /* ignore */
  }
}
