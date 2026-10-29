/**
 * T11.5.2 密钥迁移失败回退 e2e（PE-11 迁移/升级测试）。
 *
 * 与 migrateLegacyProfiles.test.ts（PE-07 T07.4-B 单测）互补：
 * 本文件聚焦「用户视角的失败回退生命周期」——
 * 模拟应用两次启动（DPAPI 不可用 → 恢复），断言：
 * - 失败非静默：security-migration-failed 事件可见 + 日志告警（AA-07 教训）；
 * - 失败回退：LS 明文保留不删（可重试）、幂等标记不置；
 * - 重启后再次尝试：DPAPI 恢复 → 迁移成功 → 标记置位 + 明文清除；
 * - 重启后仍失败 → 再次报错，明文仍在；
 * - 成功路径 + 幂等：标记置位后重启直接跳过，不重复 invoke。
 *
 * DPAPI 全部经 mock invoke（config_secret_set），CI 无真实 DPAPI 环境依赖。
 * 事件可见性经 emitUiEvent mock 断言（node 环境 window 无 addEventListener）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTauriCommand } from '../../test-setup';
import { logger } from '../../services/LoggerService';
import {
  LEGACY_MIGRATION_FLAG_KEY,
  LEGACY_PROFILES_KEY,
  ensureLegacyProfilesMigration,
  isLegacyMigrationDone,
  migrateLegacyProfiles,
  resetLegacyMigrationForTests,
} from './migrateLegacyProfiles';

const uiEventsMock = vi.hoisted(() => ({ emitUiEvent: vi.fn() }));
vi.mock('../uiEvents', () => ({ emitUiEvent: uiEventsMock.emitUiEvent }));

type SetArgs = { providerId: string; apiKey: string };

/** 成功响应：DPAPI 落盘确认（与配置事务原子提交）→ 允许剥离明文 */
function okSet(args: SetArgs): Record<string, unknown> {
  return {
    ok: true,
    profileId: args.providerId,
    hasKey: Boolean(args.apiKey),
    apiKeyLast4: (args.apiKey || 'xxxx').slice(-4),
  };
}

/** DPAPI 写失败响应（回执形状：凭据态无 hasKey=true → 迁移判失败、明文保留） */
function failSet(providerId = 'openai'): Record<string, unknown> {
  return { credentialStates: { [providerId]: { hasKey: false } } };
}

/** 注册 config_secret_set mock（invoke 层参数为 unknown，内部收敛为 SetArgs） */
function installSetMock(
  impl: (args: SetArgs) => unknown | Promise<unknown>
): ReturnType<typeof vi.fn> {
  const mock = vi.fn((args: unknown) => impl(args as SetArgs));
  mockTauriCommand('config_secret_set', mock);
  return mock;
}

/** 预置旧明文 profile 到 localStorage（模拟旧版本留下的存量数据） */
function seedLegacyProfiles(plainKey: string): void {
  localStorage.setItem(
    LEGACY_PROFILES_KEY,
    JSON.stringify([
      {
        id: 'openai',
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: plainKey,
        hasKey: true,
      },
    ])
  );
}

/** security-migration-failed 事件载荷（emitUiEvent 的 detail 参数） */
function migrationFailedEventDetails(): Array<Record<string, unknown>> {
  return uiEventsMock.emitUiEvent.mock.calls
    .filter((c) => c[0] === 'security-migration-failed')
    .map((c) => c[1] as Record<string, unknown>);
}

describe('T11.5.2 密钥迁移失败回退 e2e（启动 A 失败 → 启动 B 恢复）', () => {
  beforeEach(() => {
    localStorage.clear();
    resetLegacyMigrationForTests();
    uiEventsMock.emitUiEvent.mockClear();
  });

  afterEach(() => {
    resetLegacyMigrationForTests();
    vi.restoreAllMocks();
  });

  it('启动 A：DPAPI 持续失败 → 事件可见（非静默）+ 日志告警 + 明文保留 + 标记不置', async () => {
    seedLegacyProfiles('sk-boot-a-plain');
    mockTauriCommand('config_secret_set', async (args: SetArgs) =>
      failSet(args.providerId)
    );
    const warnSpy = vi.spyOn(logger, 'warn');

    const result = await migrateLegacyProfiles();

    // 回退语义：明文保留可重试、标记不置
    expect(result.retried).toBe(true);
    expect(result.failed).toEqual(['openai']);
    expect(result.migrated).toBe(0);
    expect(localStorage.getItem(LEGACY_PROFILES_KEY)).toContain(
      'sk-boot-a-plain'
    );
    expect(isLegacyMigrationDone()).toBe(false);

    // 非静默失败：事件已派发（attempts=2）+ 告警日志已写（AA-07 教训）
    const detail = migrationFailedEventDetails()[0] as
      Record<string, unknown> | undefined;
    expect(detail).toBeDefined();
    expect(detail!.attempts).toBe(2);
    expect(detail!.failed).toEqual(['openai']);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain('migrateLegacyProfiles 未完成');
    // 载荷脱敏：事件与日志均不含明文
    expect(JSON.stringify(detail)).not.toContain('sk-boot-a-plain');
    expect(JSON.stringify(warnSpy.mock.calls[0])).not.toContain(
      'sk-boot-a-plain'
    );
  });

  it('重启 B（DPAPI 恢复）：重试成功 → 标记置位 + 明文清除 + hasKey 保留', async () => {
    seedLegacyProfiles('sk-boot-a-plain');
    let calls = 0;
    installSetMock((args) => {
      calls += 1;
      // 启动 A：两次尝试均失败（主迁移 + 重试）；启动 B 起 DPAPI 恢复
      return calls <= 2 ? failSet(args.providerId) : okSet(args);
    });

    // ── 启动 A：失败回退 ──
    const bootA = await migrateLegacyProfiles();
    expect(bootA.failed).toEqual(['openai']);
    expect(isLegacyMigrationDone()).toBe(false);
    expect(localStorage.getItem(LEGACY_PROFILES_KEY)).toContain(
      'sk-boot-a-plain'
    );

    // ── 重启（新进程：直接调用绕过模块门控；localStorage 状态保留 = 真实重启）──
    const bootB = await migrateLegacyProfiles();

    // 重试成功：标记置位、明文清除、hasKey 保留
    expect(bootB.migrated).toBe(1);
    expect(bootB.retried).toBe(false);
    expect(bootB.failed).toEqual([]);
    expect(isLegacyMigrationDone()).toBe(true);
    const stored = JSON.parse(
      localStorage.getItem(LEGACY_PROFILES_KEY) || '[]'
    ) as Array<Record<string, unknown>>;
    expect(stored[0]?.apiKey).toBeUndefined();
    expect(stored[0]?.hasKey).toBe(true);
    expect(localStorage.getItem(LEGACY_PROFILES_KEY)).not.toContain(
      'sk-boot-a-plain'
    );
  });

  it('重启后仍失败：再次报错（事件 attempts=2）且明文仍在（可无限重试）', async () => {
    seedLegacyProfiles('sk-boot-a-plain');
    mockTauriCommand('config_secret_set', async (args: SetArgs) =>
      failSet(args.providerId)
    );

    // 启动 A：失败
    await migrateLegacyProfiles();
    expect(isLegacyMigrationDone()).toBe(false);

    // 重启 B（新进程：localStorage 状态保留）：仍失败
    const bootB = await migrateLegacyProfiles();

    expect(bootB.failed).toEqual(['openai']);
    expect(isLegacyMigrationDone()).toBe(false);
    expect(localStorage.getItem(LEGACY_PROFILES_KEY)).toContain(
      'sk-boot-a-plain'
    );
    // 两次启动各报一次错，累计 2 个事件
    const details = migrationFailedEventDetails();
    expect(details).toHaveLength(2);
    expect((details[1] as Record<string, unknown>).attempts).toBe(2);
  });

  it('成功路径：启动 A 一次成功 → 标记置位 + 明文清除；重启 B 幂等跳过（不 invoke）', async () => {
    seedLegacyProfiles('sk-boot-ok');
    const set = installSetMock((args) => okSet(args));

    // 启动 A：成功
    const bootA = await migrateLegacyProfiles();
    expect(bootA.migrated).toBe(1);
    expect(isLegacyMigrationDone()).toBe(true);
    expect(localStorage.getItem(LEGACY_PROFILES_KEY)).not.toContain(
      'sk-boot-ok'
    );
    const callsAfterBootA = set.mock.calls.length;
    // 成功无失败事件
    expect(migrationFailedEventDetails()).toHaveLength(0);

    // 重启 B（新进程）：幂等标记生效，直接跳过，不重复 invoke、不重复迁移
    const bootB = await migrateLegacyProfiles();
    expect(bootB.skipped).toBe(true);
    expect(bootB.migrated).toBe(0);
    expect(set.mock.calls.length).toBe(callsAfterBootA);
    expect(localStorage.getItem(LEGACY_MIGRATION_FLAG_KEY)).toBe('1');
  });

  it('失败后重试一次即成功：retried=true、标记置位、明文清除', async () => {
    seedLegacyProfiles('sk-retry-once');
    let calls = 0;
    const set = installSetMock((args) => {
      calls += 1;
      return calls === 1 ? failSet(args.providerId) : okSet(args);
    });

    const result = await migrateLegacyProfiles();

    expect(result.retried).toBe(true);
    expect(result.migrated).toBe(1);
    expect(set.mock.calls.length).toBe(2);
    expect(isLegacyMigrationDone()).toBe(true);
    expect(localStorage.getItem(LEGACY_PROFILES_KEY)).not.toContain(
      'sk-retry-once'
    );
  });

  it('并发门控：ensureLegacyProfilesMigration 共享同一次迁移（StrictMode 双跑安全）', async () => {
    seedLegacyProfiles('sk-concurrent');
    let applyCount = 0;
    mockTauriCommand('config_secret_set', async () => {
      applyCount += 1;
      // 成功响应须携带 hasKey=true 才允许剥离明文
      return okSet({ providerId: 'openai', apiKey: 'sk-concurrent' });
    });

    const [a, b] = await Promise.all([
      ensureLegacyProfilesMigration(),
      ensureLegacyProfilesMigration(),
    ]);
    expect(a.migrated).toBe(1);
    expect(b.migrated).toBe(1);
    expect(applyCount).toBe(1);
    expect(isLegacyMigrationDone()).toBe(true);
  });
});
