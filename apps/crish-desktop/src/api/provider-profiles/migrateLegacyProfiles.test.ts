/**
 * 旧明文密钥一次性迁移测试（PE-07 T07.4-B）：
 * - 成功：旧 LS 明文 → config_profile_apply（mock 断言收到 key）→ LS 无明文 + hasKey 保留；
 * - 幂等：重复启动不重复迁移（标记跳过，无重复写、无告警）；
 * - 失败重试一次；持续失败 → 明文保留 + 标记不置 + security-migration-failed 事件；
 * - 降级（非 persisted）→ 明文保留（防密钥丢失）；
 * - 全 LS 键扫描断言（残留明文键检出）。
 *
 * 经 test-setup 的 tauri mock（mockTauriCommand）走真实 rustProfileStore +
 * invokeTyped 链路，同时校验 wire 参数形状（camelCase）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTauriCommand } from '../../test-setup';
import {
  LEGACY_MIGRATION_FLAG_KEY,
  LEGACY_PROFILES_KEY,
  isLegacyMigrationDone,
  migrateLegacyProfiles,
  resetLegacyMigrationForTests,
  scanLocalStorageForPlaintextKeys,
} from './migrateLegacyProfiles';

type ApplyArgs = { profileId: string; apiKey?: string; baseUrl?: string; model?: string };

/** mock invoke 的返回值即命令 data（invokeTyped 负责外层 { status, data } 包装） */
function okApply(args: ApplyArgs): Record<string, unknown> {
  return {
    ok: true,
    profileId: args.profileId,
    hasApiKey: Boolean(args.apiKey),
    apiKeyLast4: (args.apiKey || 'xxxx').slice(-4),
    credentialMode: 'direct',
    credentialPersistence: 'persisted',
  };
}

describe('migrateLegacyProfiles（PE-07 T07.4-B）', () => {
  beforeEach(() => {
    localStorage.clear();
    resetLegacyMigrationForTests();
  });

  afterEach(() => {
    resetLegacyMigrationForTests();
  });

  it('T07.4 用例 1：旧 LS 明文 → DPAPI（mock apply 收到 key）→ LS 无明文、hasKey 保留', async () => {
    localStorage.setItem(
      LEGACY_PROFILES_KEY,
      JSON.stringify([
        { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: [], apiKey: 'sk-test-123', hasKey: true },
        { id: 'deepseek', name: 'DS', baseUrl: 'https://api.deepseek.com', models: ['m'], hasKey: false },
      ])
    );
    const apply = vi.fn(async (args: ApplyArgs) => okApply(args));
    mockTauriCommand('config_profile_apply', apply);

    const result = await migrateLegacyProfiles();

    expect(result.migrated).toBe(1);
    expect(result.skipped).toBe(false);
    expect(apply).toHaveBeenCalledWith({
      profileId: 'openai',
      apiKey: 'sk-test-123',
    });
    const stored = JSON.parse(localStorage.getItem(LEGACY_PROFILES_KEY) || '[]') as Array<
      Record<string, unknown>
    >;
    expect(stored[0].apiKey).toBeUndefined();
    expect(stored[0].hasKey).toBe(true);
    expect(stored[1].apiKey).toBeUndefined();
    expect(localStorage.getItem(LEGACY_PROFILES_KEY)).not.toContain('sk-test-123');
    expect(isLegacyMigrationDone()).toBe(true);
  });

  it('T07.4 用例 2：迁移幂等——重复执行不重复写、不告警', async () => {
    localStorage.setItem(
      LEGACY_PROFILES_KEY,
      JSON.stringify([
        { id: 'openai', baseUrl: 'https://x', models: [], apiKey: 'sk-abc-123', hasKey: true },
      ])
    );
    const apply = vi.fn(async (args: ApplyArgs) => okApply(args));
    mockTauriCommand('config_profile_apply', apply);

    const first = await migrateLegacyProfiles();
    expect(first.migrated).toBe(1);
    const callsAfterFirst = apply.mock.calls.length;

    const second = await migrateLegacyProfiles();
    expect(second.skipped).toBe(true);
    expect(second.migrated).toBe(0);
    expect(apply.mock.calls.length).toBe(callsAfterFirst);
  });

  it('迁移失败 → 重试一次后成功（retried=true，标记置位）', async () => {
    localStorage.setItem(
      LEGACY_PROFILES_KEY,
      JSON.stringify([
        { id: 'openai', baseUrl: 'https://x', models: [], apiKey: 'sk-retry-me', hasKey: true },
      ])
    );
    let calls = 0;
    const apply = vi.fn(async (args: ApplyArgs) => {
      calls += 1;
      if (calls === 1) {
        return { status: 'error', kind: 'Io', message: 'dpapi write failed' } as const;
      }
      return okApply(args);
    });
    mockTauriCommand('config_profile_apply', apply);

    const result = await migrateLegacyProfiles();

    expect(result.retried).toBe(true);
    expect(result.migrated).toBe(1);
    expect(apply.mock.calls.length).toBe(2);
    expect(localStorage.getItem(LEGACY_PROFILES_KEY)).not.toContain('sk-retry-me');
    expect(isLegacyMigrationDone()).toBe(true);
  });

  it('持续失败 → 明文保留 + 标记不置 + security-migration-failed 事件', async () => {
    localStorage.setItem(
      LEGACY_PROFILES_KEY,
      JSON.stringify([
        { id: 'openai', baseUrl: 'https://x', models: [], apiKey: 'sk-still-plain', hasKey: true },
      ])
    );
    const failedEvents: unknown[] = [];
    window.addEventListener('crish-security-migration-failed', (ev) => {
      failedEvents.push((ev as CustomEvent).detail);
    });
    mockTauriCommand('config_profile_apply', async () => ({
      status: 'error',
      kind: 'Io',
      message: 'dpapi unavailable',
    }));

    const result = await migrateLegacyProfiles();

    expect(result.retried).toBe(true);
    expect(result.failed).toEqual(['openai']);
    expect(result.migrated).toBe(0);
    // 明文保留（可重试）且幂等标记不置
    expect(localStorage.getItem(LEGACY_PROFILES_KEY)).toContain('sk-still-plain');
    expect(isLegacyMigrationDone()).toBe(false);
    // 失败事件已派发（载荷无明文）
    expect(failedEvents).toHaveLength(1);
    const detail = failedEvents[0] as { attempts: number; failed: string[] };
    expect(detail.attempts).toBe(2);
    expect(detail.failed).toEqual(['openai']);
    expect(JSON.stringify(detail)).not.toContain('sk-still-plain');
  });

  it('降级（persistence != persisted）→ 明文保留、degraded 计数、标记不置（防密钥丢失）', async () => {
    localStorage.setItem(
      LEGACY_PROFILES_KEY,
      JSON.stringify([
        { id: 'openai', baseUrl: 'https://x', models: [], apiKey: 'sk-degraded', hasKey: true },
      ])
    );
    mockTauriCommand('config_profile_apply', async (args: ApplyArgs) => ({
      ok: true,
      profileId: args.profileId,
      hasApiKey: true,
      apiKeyLast4: 'aded',
      credentialMode: 'direct',
      credentialPersistence: 'degraded',
    }));

    const result = await migrateLegacyProfiles();

    expect(result.degraded).toBe(1);
    expect(result.migrated).toBe(0);
    expect(localStorage.getItem(LEGACY_PROFILES_KEY)).toContain('sk-degraded');
    expect(isLegacyMigrationDone()).toBe(false);
  });

  it('活动 profile 最后 apply（引擎最终持有活动 profile 的密钥）', async () => {
    localStorage.setItem(
      LEGACY_PROFILES_KEY,
      JSON.stringify([
        { id: 'a', baseUrl: 'https://a', models: [], apiKey: 'sk-aaa', hasKey: true },
        { id: 'b', baseUrl: 'https://b', models: [], apiKey: 'sk-bbb', hasKey: true },
      ])
    );
    localStorage.setItem('crish_active_profile_id', 'b');
    const apply = vi.fn(async (args: ApplyArgs) => okApply(args));
    mockTauriCommand('config_profile_apply', apply);

    await migrateLegacyProfiles();

    const order = apply.mock.calls.map((c) => (c[0] as ApplyArgs).profileId);
    expect(order).toEqual(['a', 'b']);
  });

  it('全 LS 键扫描：残留明文键被检出（residualKeys），迁移视为未完成', async () => {
    localStorage.setItem(
      LEGACY_PROFILES_KEY,
      JSON.stringify([
        { id: 'openai', baseUrl: 'https://x', models: [], apiKey: 'sk-scan', hasKey: true },
      ])
    );
    // 另一个键里藏了含 apiKey 的 JSON（模拟历史遗留存储）
    localStorage.setItem('some_other_legacy_key', JSON.stringify({ auth: { apiKey: 'sk-elsewhere' } }));
    mockTauriCommand('config_profile_apply', async (args: ApplyArgs) => okApply(args));

    const result = await migrateLegacyProfiles();

    expect(result.residualKeys).toContain('some_other_legacy_key');
    // 主键已剥离
    expect(localStorage.getItem(LEGACY_PROFILES_KEY)).not.toContain('sk-scan');
    // 扫描函数可直接使用
    expect(scanLocalStorageForPlaintextKeys()).toEqual(['some_other_legacy_key']);
    // 残留 → 不置标记（下次启动重试 + 告警）
    expect(isLegacyMigrationDone()).toBe(false);
  });

  it('无存量数据 → 直接置标记跳过（不 invoke）', async () => {
    const apply = vi.fn(async (args: ApplyArgs) => okApply(args));
    mockTauriCommand('config_profile_apply', apply);
    const result = await migrateLegacyProfiles();
    expect(result.skipped).toBe(true);
    expect(apply).not.toHaveBeenCalled();
    expect(isLegacyMigrationDone()).toBe(true);
  });
});
