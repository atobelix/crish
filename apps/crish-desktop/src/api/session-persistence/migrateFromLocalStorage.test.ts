/**
 * T11.5.3 localStorage → SQLite 迁移 e2e（PE-11 迁移/升级测试；T08.10 产物补全）。
 *
 * 场景（全部经 mock invoke 走真实 sessionRustDb → invokeResult 链路）：
 * - e2e 全流程：构造 LS 数据（index/body/agents/active/folder）→ ensureMigrated →
 *   import_from_localstorage 收到完整载荷（假库落盘 = SQLite 有数据）→
 *   schema_version='3' 置位 + migration_completed_at 写入 → LS 数据保留（30 天回滚保险）；
 * - 幂等：重复 ensureMigrated 不重复导入；
 * - 失败路径：invoke missing（import 返回 null）→ 标记不置、LS 保留、下次启动重试成功；
 * - 空环境：无 LS 数据 → 直接标记已迁移、不 invoke；
 * - 已迁移：schema_version='3' → 直接跳过；
 * - LS 清理：迁移满 30 天后 runMigrationCleanupIfNeeded 清空会话 key、保留非会话数据。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTauriCommand } from '../../test-setup';
import {
  SCHEMA_VERSION_KEY,
  SCHEMA_VERSION_V3,
  ensureMigrated,
  runMigrationCleanupIfNeeded,
} from './migrateFromLocalStorage';
import {
  SESSION_ACTIVE_KEY,
  SESSION_AGENTS_PREFIX,
  SESSION_BODY_PREFIX,
  SESSION_FOLDER_KEY,
  SESSION_INDEX_KEY,
} from './sessionPersistenceTypes';

/** 假库：模拟 Rust SQLite 侧（import_from_localstorage 落盘 + meta 表） */
function makeFakeSqlite() {
  const sessions = new Map<string, { title: string; body: unknown[]; agents: unknown[] }>();
  const meta = new Map<string, string>();
  const importCalls: Array<Record<string, unknown>> = [];

  mockTauriCommand('get_session_meta', async (args: unknown) => {
    const { key } = args as { key: string };
    return meta.get(key) ?? null;
  });
  mockTauriCommand('set_session_meta', async (args: unknown) => {
    const { key, value } = args as { key: string; value: string };
    meta.set(key, value);
    return undefined;
  });
  mockTauriCommand('import_from_localstorage', async (args: unknown) => {
    const a = args as {
      indexJson: string;
      bodies: Record<string, string>;
      agents: Record<string, string>;
      activeSessionId: string | null;
      folderOrder: string[];
    };
    importCalls.push(a as unknown as Record<string, unknown>);
    // 假库落盘：解析 index 载荷 → sessions 表（等价 SQLite 有数据）
    const entries = JSON.parse(a.indexJson) as Array<{ id: string; title: string }>;
    for (const e of entries) {
      const bodyRaw = a.bodies[e.id];
      const body = bodyRaw ? JSON.parse(bodyRaw) : [];
      const agentsRaw = a.agents[e.id];
      const agents = agentsRaw ? JSON.parse(agentsRaw) : [];
      sessions.set(e.id, { title: e.title, body, agents });
    }
    return { sessions: entries.length, messages: 0, agents: 0 };
  });
  // P0-1（N0-1）修复：30 天清理需逐 key 校验 SQLite 存在性——
  // 假库补 list_sessions / load_session_body / load_session_agents 读面
  mockTauriCommand('list_sessions', async () =>
    [...sessions.keys()].map((id) => {
      const s = sessions.get(id)!;
      return {
        id,
        title: s.title,
        folder: '常规会话',
        isPinned: false,
        isArchived: false,
        timestamp: '2026-01-01T00:00:00Z',
        updatedAt: 1500,
        messageCount: (s.body ?? []).length,
      };
    }),
  );
  mockTauriCommand('load_session_body', async (args: unknown) => {
    const { sessionId } = args as { sessionId: string };
    return sessions.get(sessionId)?.body ?? [];
  });
  mockTauriCommand('load_session_agents', async (args: unknown) => {
    const { sessionId } = args as { sessionId: string };
    return sessions.get(sessionId)?.agents ?? [];
  });

  return { sessions, meta, importCalls };
}

/** 构造旧版本遗留的 localStorage 会话数据（index/body/agents/active/folder） */
function seedLegacyLocalStorage(): void {
  localStorage.setItem(
    SESSION_INDEX_KEY,
    JSON.stringify([
      { id: 's1', title: '历史会话一', folder: '工作', isPinned: false, isArchived: false, timestamp: '2026-01-01T00:00:00Z', updatedAt: 1500, messageCount: 2 },
      { id: 's2', title: '历史会话二', folder: '常规会话', isPinned: true, isArchived: false, timestamp: '2026-01-02T00:00:00Z', updatedAt: 1200, messageCount: 1 },
    ])
  );
  localStorage.setItem(
    SESSION_BODY_PREFIX + 's1',
    JSON.stringify([
      { id: 'm1', sender: 'user', text: '你好', timestamp: 100, status: 'completed' },
      { id: 'm2', sender: 'assistant', text: '你好，有什么可以帮你', timestamp: 200, status: 'completed' },
    ])
  );
  localStorage.setItem(SESSION_BODY_PREFIX + 's2', JSON.stringify([{ id: 'm1', sender: 'user', text: '旧消息', timestamp: 300, status: 'completed' }]));
  localStorage.setItem(
    SESSION_AGENTS_PREFIX + 's1',
    JSON.stringify([
      {
        id: 'a1', subagentRunId: 'run-1', parentSessionId: 's1', parentRunId: 'prun-1',
        description: '探索', mode: 'explore', status: 'completed',
        messages: [{ id: 'am1', sender: 'assistant', text: '子代理结果', timestamp: 150, status: 'completed' }],
        startedAt: 120,
      },
    ])
  );
  localStorage.setItem(SESSION_ACTIVE_KEY, 's1');
  localStorage.setItem(SESSION_FOLDER_KEY, JSON.stringify(['工作', '常规会话']));
  localStorage.setItem('crish_ui_pref_theme', 'dark'); // 非会话数据（保留）
}

describe('T11.5.3 localStorage → SQLite 迁移 e2e', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('e2e 全流程：LS 数据 → 迁移 → SQLite 有数据（载荷落盘）→ schema_version=3 → LS 保留', async () => {
    seedLegacyLocalStorage();
    const fake = makeFakeSqlite();

    await ensureMigrated();

    // schema_version 置位 + 迁移完成时间戳
    expect(fake.meta.get(SCHEMA_VERSION_KEY)).toBe(SCHEMA_VERSION_V3);
    expect(fake.meta.has('migration_completed_at')).toBe(true);

    // import 载荷完整：index/body/agents/active/folder 全部送达
    expect(fake.importCalls).toHaveLength(1);
    const payload = fake.importCalls[0] as Record<string, unknown> | undefined;
    expect(payload).toBeDefined();
    const index = JSON.parse(payload!.indexJson as string) as Array<{ id: string }>;
    expect(index.map((e) => e.id)).toEqual(['s1', 's2']);
    expect(Object.keys(payload!.bodies as Record<string, string>)).toEqual(['s1', 's2']);
    expect(Object.keys(payload!.agents as Record<string, string>)).toEqual(['s1']);
    expect(payload!.activeSessionId).toBe('s1');
    expect(payload!.folderOrder).toEqual(['工作', '常规会话']);

    // SQLite（假库）有数据：会话/消息/子代理
    expect(fake.sessions.size).toBe(2);
    expect(fake.sessions.get('s1')?.title).toBe('历史会话一');
    expect(fake.sessions.get('s1')?.body).toHaveLength(2);
    expect(fake.sessions.get('s2')?.body).toHaveLength(1);
    expect(fake.sessions.get('s1')?.agents).toHaveLength(1);

    // LS 数据保留（30 天回滚保险：迁移不立即清理）
    expect(localStorage.getItem(SESSION_INDEX_KEY)).not.toBeNull();
    expect(localStorage.getItem(SESSION_BODY_PREFIX + 's1')).toContain('你好');
  });

  it('幂等：重复 ensureMigrated 不重复导入（schema_version=3 直接跳过）', async () => {
    seedLegacyLocalStorage();
    const fake = makeFakeSqlite();

    await ensureMigrated();
    expect(fake.importCalls).toHaveLength(1);
    await ensureMigrated();
    expect(fake.importCalls).toHaveLength(1);
    expect(fake.sessions.size).toBe(2);
  });

  it('失败路径：invoke missing（import 返回 null）→ 标记不置、LS 保留、下次启动重试成功', async () => {
    seedLegacyLocalStorage();
    const meta = new Map<string, string>();

    mockTauriCommand('get_session_meta', async (args: unknown) => {
      const { key } = args as { key: string };
      return meta.get(key) ?? null;
    });
    mockTauriCommand('set_session_meta', async (args: unknown) => {
      const { key, value } = args as { key: string; value: string };
      meta.set(key, value);
      return undefined;
    });
    // 启动 A：import 返回 null（invoke missing / 无数据语义）→ 迁移失败
    mockTauriCommand('import_from_localstorage', async () => null);

    await ensureMigrated();
    expect(meta.get(SCHEMA_VERSION_KEY)).toBeUndefined();
    expect(localStorage.getItem(SESSION_INDEX_KEY)).not.toBeNull();
    expect(localStorage.getItem(SESSION_BODY_PREFIX + 's1')).toContain('你好');

    // 启动 B：命令恢复 → 重试成功
    let importOk = false;
    mockTauriCommand('import_from_localstorage', async () => {
      importOk = true;
      return { sessions: 2, messages: 3, agents: 1 };
    });
    await ensureMigrated();
    expect(importOk).toBe(true);
    expect(meta.get(SCHEMA_VERSION_KEY)).toBe(SCHEMA_VERSION_V3);
  });

  it('空环境：无 LS 会话数据 → 直接标记已迁移、不 invoke', async () => {
    const fake = makeFakeSqlite();

    await ensureMigrated();

    expect(fake.meta.get(SCHEMA_VERSION_KEY)).toBe(SCHEMA_VERSION_V3);
    expect(fake.importCalls).toHaveLength(0);
  });

  it('已迁移环境：schema_version=3 → 直接返回（不触 import）', async () => {
    seedLegacyLocalStorage();
    const fake = makeFakeSqlite();
    fake.meta.set(SCHEMA_VERSION_KEY, SCHEMA_VERSION_V3);

    await ensureMigrated();

    expect(fake.importCalls).toHaveLength(0);
    // LS 数据原样保留
    expect(localStorage.getItem(SESSION_INDEX_KEY)).not.toBeNull();
  });

  it('LS 清理 e2e：迁移满 30 天后清理会话 key、保留非会话数据；未满 30 天不清', async () => {
    seedLegacyLocalStorage();
    const fake = makeFakeSqlite();
    const baseTime = 1_752_500_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseTime);

    // 迁移完成（时间戳 = baseTime）
    await ensureMigrated();
    expect(fake.meta.get('migration_completed_at')).toBe(String(baseTime));

    // 未满 30 天：清理任务跳过
    await runMigrationCleanupIfNeeded();
    expect(localStorage.getItem(SESSION_INDEX_KEY)).not.toBeNull();

    // 满 30 天后：会话数据清理，非会话数据保留
    nowSpy.mockReturnValue(baseTime + 31 * 24 * 60 * 60 * 1000);
    await runMigrationCleanupIfNeeded();
    expect(localStorage.getItem(SESSION_INDEX_KEY)).toBeNull();
    expect(localStorage.getItem(SESSION_BODY_PREFIX + 's1')).toBeNull();
    expect(localStorage.getItem(SESSION_BODY_PREFIX + 's2')).toBeNull();
    expect(localStorage.getItem(SESSION_AGENTS_PREFIX + 's1')).toBeNull();
    expect(localStorage.getItem(SESSION_ACTIVE_KEY)).toBeNull();
    expect(localStorage.getItem(SESSION_FOLDER_KEY)).toBeNull();
    expect(localStorage.getItem('crish_ui_pref_theme')).toBe('dark');

    // 清理完成后幂等：再次调用不再清（legacy_localstorage_cleaned=1）
    expect(fake.meta.get('legacy_localstorage_cleaned')).toBe('1');
    nowSpy.mockReturnValue(baseTime + 1000);
    await runMigrationCleanupIfNeeded();
    expect(fake.importCalls).toHaveLength(1);
  });

  it('P0-1 回归（N0-1）：SQLite 缺失的 LS-only 会话保留、不置位 cleaned；回迁后重试成功', async () => {
    seedLegacyLocalStorage();
    const fake = makeFakeSqlite();
    const baseTime = 1_752_500_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseTime);

    // 迁移完成（时间戳 = baseTime）
    await ensureMigrated();
    expect(fake.meta.get('migration_completed_at')).toBe(String(baseTime));

    // 降级窗口模拟：LS 新增一个 SQLite 未持有的会话（磁盘恢复前写入的唯一副本）
    localStorage.setItem(
      SESSION_BODY_PREFIX + 'ls-only-new',
      JSON.stringify([
        { id: 'm9', sender: 'user', text: '降级期消息', timestamp: 999, status: 'completed' },
      ]),
    );

    // 满 30 天后：只删 SQLite 确认持有的会话；ls-only-new 保留、不置位 cleaned
    nowSpy.mockReturnValue(baseTime + 31 * 24 * 60 * 60 * 1000);
    await runMigrationCleanupIfNeeded();
    expect(localStorage.getItem(SESSION_BODY_PREFIX + 's1')).toBeNull();
    expect(localStorage.getItem(SESSION_BODY_PREFIX + 'ls-only-new')).not.toBeNull();
    expect(localStorage.getItem(SESSION_INDEX_KEY)).not.toBeNull();
    expect(fake.meta.get('legacy_localstorage_cleaned')).toBeUndefined();

    // SQLite 补入该会话（磁盘恢复后 hydrate/persist 回迁）→ 重试成功
    fake.sessions.set('ls-only-new', {
      title: 'LS-only',
      body: [{ id: 'm9', sender: 'user', text: '降级期消息', timestamp: 999 }],
      agents: [],
    });
    await runMigrationCleanupIfNeeded();
    expect(localStorage.getItem(SESSION_BODY_PREFIX + 'ls-only-new')).toBeNull();
    expect(fake.meta.get('legacy_localstorage_cleaned')).toBe('1');
  });
});
