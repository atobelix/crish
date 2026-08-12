// 迁移测试（Z0 R2-13 验收锚点：迁移幂等测试 v0 逐级升最新；M5 §5.4 迁移纪律）
import { migrateIfNeeded } from './db';
import { MemorySqlDriver } from './driver';
import { LATEST_VERSION, type Migration } from './migrations';
import { SCHEMA_VERSION, TABLES } from './schema';

describe('迁移：全新库直达最新（v0 → 最新）', () => {
  it('v0 空库迁移到 LATEST_VERSION，8 表全部建成', async () => {
    const db = new MemorySqlDriver();
    const version = await migrateIfNeeded(db);
    expect(version).toBe(LATEST_VERSION);
    expect(LATEST_VERSION).toBe(SCHEMA_VERSION);
    expect(db.listTables()).toEqual([...TABLES].sort());
    // 表结构可查询（SELECT 不报错即建表成功）
    for (const table of TABLES) {
      await expect(
        db.getAll(`SELECT * FROM ${table} LIMIT 1`)
      ).resolves.toEqual([]);
    }
  });

  it('迁移后 PRAGMA user_version = 最新版本', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    await expect(db.getFirst('PRAGMA user_version')).resolves.toEqual({
      user_version: LATEST_VERSION,
    });
  });
});

describe('迁移：幂等重复执行不破坏', () => {
  it('重复迁移不报错、不重复建表、版本不变', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    await expect(migrateIfNeeded(db)).resolves.toBe(LATEST_VERSION);
    expect(db.listTables()).toHaveLength(TABLES.length);
    await expect(db.getFirst('PRAGMA user_version')).resolves.toEqual({
      user_version: LATEST_VERSION,
    });
  });

  it('迁移前已有的业务数据在重复迁移后保留（业务数据保留纪律，M5 §5.4）', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    await db.exec('INSERT INTO settings (key, value) VALUES (?, ?)', [
      'cursor:session:s1',
      '42',
    ]);
    await db.exec(
      `INSERT INTO approval_queue (id, tool_call_id, decision, msg_id, status, attempts, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['q1', 'tc1', 'approved', 'm1', 'pending', 0, 1000, 1000]
    );
    await migrateIfNeeded(db); // 幂等重复执行
    const settings = await db.getFirst<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?',
      ['cursor:session:s1']
    );
    expect(settings?.value).toBe('42');
    expect(db.rowCount('approval_queue')).toBe(1);
  });
});

describe('迁移：从中间版本逐级升最新', () => {
  it('v1 已迁移的库只补跑后续迁移（构造 v1→v2→v3 场景）', async () => {
    const db = new MemorySqlDriver();
    const fakeMigrations: readonly Migration[] = [
      {
        name: 'v1-base',
        sql: ['CREATE TABLE IF NOT EXISTS t_base (id TEXT PRIMARY KEY)'],
      },
      {
        name: 'v2-add',
        sql: ['CREATE TABLE IF NOT EXISTS t_v2 (id TEXT PRIMARY KEY)'],
      },
      {
        name: 'v3-add',
        sql: ['CREATE TABLE IF NOT EXISTS t_v3 (id TEXT PRIMARY KEY)'],
      },
    ];
    // 模拟旧版本库：只执行 v1
    await migrateIfNeeded(db, fakeMigrations.slice(0, 1));
    expect(db.listTables()).toEqual(['t_base']);
    await migrateIfNeeded(db, fakeMigrations);
    expect(db.listTables()).toEqual(['t_base', 't_v2', 't_v3']);
    await expect(db.getFirst('PRAGMA user_version')).resolves.toEqual({
      user_version: 3,
    });
  });

  it('中间迁移失败不推进版本（事务边界语义）', async () => {
    const db = new MemorySqlDriver();
    const badMigrations: readonly Migration[] = [
      {
        name: 'v1-ok',
        sql: ['CREATE TABLE IF NOT EXISTS t_ok (id TEXT PRIMARY KEY)'],
      },
      {
        name: 'v2-bad',
        sql: [
          'CREATE TABLE IF NOT EXISTS t_bad (id TEXT PRIMARY KEY)',
          'SELEC broken',
        ],
      },
    ];
    await expect(migrateIfNeeded(db, badMigrations)).rejects.toThrow();
    // v2 失败后版本停在 1；已成功执行的 v1 语句保留（与 SQLite 事务提交语义一致）
    await expect(db.getFirst('PRAGMA user_version')).resolves.toEqual({
      user_version: 1,
    });
  });
});

describe('迁移：版本一致性护栏', () => {
  it('MIGRATIONS 长度与 SCHEMA_VERSION 一致（不一致会抛错）', () => {
    expect(LATEST_VERSION).toBe(SCHEMA_VERSION);
  });
});
