/**
 * 旧明文密钥一次性迁移测试（PE-07 T07.4-B）：
 * - 成功：旧 LS 明文 → config_secret_set（mock 断言收到 key）→ LS 无明文 + hasKey 保留；
 * - 幂等：重复启动不重复迁移（标记跳过，无重复写、无告警）；
 * - 失败重试一次；持续失败 → 明文保留 + 标记不置 + security-migration-failed 事件；
 * - 全 LS 键扫描断言（残留明文键检出）。
 *
 * 经 test-setup 的 tauri mock（mockTauriCommand）走真实 rustProfileStore +
 * invokeTyped 链路，同时校验 wire 参数形状（camelCase + expectedRevision）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTauriCommand } from '../../test-setup';
import { logger } from '../../services/LoggerService';
import {
  LEGACY_PROFILES_KEY,
  isLegacyMigrationDone,
  migrateLegacyProfiles,
  resetLegacyMigrationForTests,
  scanLocalStorageForPlaintextKeys,
} from './migrateLegacyProfiles';

type SetArgs = { providerId: string; apiKey: string };

/** mock invoke 的返回值即命令 data（invokeTyped 负责外层 { status, data } 包装） */
function okSet(args: SetArgs): Record<string, unknown> {
  return {
    ok: true,
    profileId: args.providerId,
    hasKey: Boolean(args.apiKey),
    apiKeyLast4: (args.apiKey || 'xxxx').slice(-4),
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

  it('T07.4 用例 1：旧 LS 明文 → DPAPI（mock 收到 key）→ LS 无明文、hasKey 保留', async () => {
    localStorage.setItem(
      LEGACY_PROFILES_KEY,
      JSON.stringify([
        {
          id: 'openai',
          name: 'OpenAI',
          baseUrl: 'https://api.openai.com/v1',
          models: [],
          apiKey: 'sk-test-123',
          hasKey: true,
        },
        {
          id: 'deepseek',
          name: 'DS',
          baseUrl: 'https://api.deepseek.com',
          models: ['m'],
          hasKey: false,
        },
      ])
    );
    const set = vi.fn(async (args: SetArgs) => okSet(args));
    mockTauriCommand('config_secret_set', set);

    const result = await migrateLegacyProfiles();

    expect(result.migrated).toBe(1);
    expect(result.skipped).toBe(false);
    expect(set).toHaveBeenCalledWith({
      providerId: 'openai',
      apiKey: 'sk-test-123',
      expectedRevision: '',
    });
    const stored = JSON.parse(
      localStorage.getItem(LEGACY_PROFILES_KEY) || '[]'
    ) as Array<Record<string, unknown>>;
    expect(stored[0].apiKey).toBeUndefined();
    expect(stored[0].hasKey).toBe(true);
    expect(stored[1].apiKey).toBeUndefined();
    expect(localStorage.getItem(LEGACY_PROFILES_KEY)).not.toContain(
      'sk-test-123'
    );
    expect(isLegacyMigrationDone()).toBe(true);
  });

  it('T07.4 用例 2：迁移幂等——重复执行不重复写、不告警', async () => {
    localStorage.setItem(
      LEGACY_PROFILES_KEY,
      JSON.stringify([
        {
          id: 'openai',
          baseUrl: 'https://x',
          models: [],
          apiKey: 'sk-abc-123',
          hasKey: true,
        },
      ])
    );
    const set = vi.fn(async (args: SetArgs) => okSet(args));
    mockTauriCommand('config_secret_set', set);

    const first = await migrateLegacyProfiles();
    expect(first.migrated).toBe(1);
    const callsAfterFirst = set.mock.calls.length;

    const second = await migrateLegacyProfiles();
    expect(second.skipped).toBe(true);
    expect(second.migrated).toBe(0);
    expect(set.mock.calls.length).toBe(callsAfterFirst);
  });

  it('迁移失败 → 重试一次后成功（retried=true，标记置位）', async () => {
    localStorage.setItem(
      LEGACY_PROFILES_KEY,
      JSON.stringify([
        {
          id: 'openai',
          baseUrl: 'https://x',
          models: [],
          apiKey: 'sk-retry-me',
          hasKey: true,
        },
      ])
    );
    let calls = 0;
    const set = vi.fn(async (args: SetArgs) => {
      calls += 1;
      if (calls === 1) {
        // DPAPI 写失败模拟：回执形状 = 快照凭据态（无 hasKey=true → 迁移判失败、明文保留）
        return {
          credentialStates: { [args.providerId]: { hasKey: false } },
        };
      }
      return {
        credentialStates: { [args.providerId]: { hasKey: true } },
      };
    });
    mockTauriCommand('config_secret_set', set);

    const result = await migrateLegacyProfiles();

    expect(result.retried).toBe(true);
    expect(result.migrated).toBe(1);
    expect(set.mock.calls.length).toBe(2);
    expect(localStorage.getItem(LEGACY_PROFILES_KEY)).not.toContain(
      'sk-retry-me'
    );
    expect(isLegacyMigrationDone()).toBe(true);
  });

  it('持续失败 → 明文保留 + 标记不置 + security-migration-failed 事件', async () => {
    localStorage.setItem(
      LEGACY_PROFILES_KEY,
      JSON.stringify([
        {
          id: 'openai',
          baseUrl: 'https://x',
          models: [],
          apiKey: 'sk-still-plain',
          hasKey: true,
        },
      ])
    );
    const failedEvents: unknown[] = [];
    window.addEventListener('crish-security-migration-failed', (ev) => {
      failedEvents.push((ev as CustomEvent).detail);
    });
    mockTauriCommand('config_secret_set', async (args: SetArgs) => ({
      credentialStates: { [args.providerId]: { hasKey: false } },
    }));

    const result = await migrateLegacyProfiles();

    expect(result.retried).toBe(true);
    expect(result.failed).toEqual(['openai']);
    expect(result.migrated).toBe(0);
    // 明文保留（可重试）且幂等标记不置
    expect(localStorage.getItem(LEGACY_PROFILES_KEY)).toContain(
      'sk-still-plain'
    );
    expect(isLegacyMigrationDone()).toBe(false);
    // 失败事件已派发（载荷无明文）
    expect(failedEvents).toHaveLength(1);
    const detail = failedEvents[0] as { attempts: number; failed: string[] };
    expect(detail.attempts).toBe(2);
    expect(detail.failed).toEqual(['openai']);
    expect(JSON.stringify(detail)).not.toContain('sk-still-plain');
  });

  it('全 LS 键扫描：残留明文键被检出（residualKeys），迁移视为未完成', async () => {
    localStorage.setItem(
      LEGACY_PROFILES_KEY,
      JSON.stringify([
        {
          id: 'openai',
          baseUrl: 'https://x',
          models: [],
          apiKey: 'sk-scan',
          hasKey: true,
        },
      ])
    );
    // 另一个键里藏了含 apiKey 的 JSON（模拟历史遗留存储）
    localStorage.setItem(
      'some_other_legacy_key',
      JSON.stringify({ auth: { apiKey: 'sk-elsewhere' } })
    );
    mockTauriCommand('config_secret_set', async (args: SetArgs) => okSet(args));

    const result = await migrateLegacyProfiles();

    expect(result.residualKeys).toContain('some_other_legacy_key');
    // 主键已剥离
    expect(localStorage.getItem(LEGACY_PROFILES_KEY)).not.toContain('sk-scan');
    // 扫描函数可直接使用
    expect(scanLocalStorageForPlaintextKeys()).toEqual([
      'some_other_legacy_key',
    ]);
    // 残留 → 不置标记（下次启动重试 + 告警）
    expect(isLegacyMigrationDone()).toBe(false);
  });

  it('无存量数据 → 直接置标记跳过（不 invoke）', async () => {
    const set = vi.fn(async (args: SetArgs) => okSet(args));
    mockTauriCommand('config_secret_set', set);
    const result = await migrateLegacyProfiles();
    expect(result.skipped).toBe(true);
    expect(set).not.toHaveBeenCalled();
    expect(isLegacyMigrationDone()).toBe(true);
  });

  it('历史无主键（crish_providers / conex_pi_providers）明文剥离 → 无残留、置标记、无重复告警', async () => {
    // 2026-08-08 真实噪音回归：这两个死键含 apiKey → 迁移每次启动报残留告警、
    // 幂等标记永不置位。修复后剥离明文（保留 hasKey），一次完成、二次静默。
    localStorage.setItem(
      'crish_providers',
      JSON.stringify([{ id: 'flowbit', apiKey: 'sk-orphan-1', hasKey: false }])
    );
    localStorage.setItem(
      'conex_pi_providers',
      JSON.stringify({ profile: { id: 'pi', apiKey: 'sk-orphan-2' } })
    );
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const first = await migrateLegacyProfiles();

    expect(first.residualKeys).toEqual([]);
    expect(isLegacyMigrationDone()).toBe(true);
    // 明文已剥离、hasKey 保留
    expect(localStorage.getItem('crish_providers')).not.toContain(
      'sk-orphan-1'
    );
    expect(localStorage.getItem('conex_pi_providers')).not.toContain(
      'sk-orphan-2'
    );
    expect(
      JSON.parse(localStorage.getItem('crish_providers') || '[]')[0]
    ).toMatchObject({
      id: 'flowbit',
      hasKey: true,
    });

    // 二次启动：标记跳过、无告警（噪音消除）
    const second = await migrateLegacyProfiles();
    expect(second.skipped).toBe(true);
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('migrateLegacyProfiles 未完成'),
      expect.anything()
    );

    warnSpy.mockRestore();
  });
});
