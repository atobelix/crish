// 迁移测试（Z0 R2-13 验收锚点：迁移幂等测试 v0 逐级升最新；M5 §5.4 迁移纪律）
import { migrateIfNeeded } from './db';
import { MemorySqlDriver } from './driver';
import { LATEST_VERSION, MIGRATIONS, type Migration } from './migrations';
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

describe('迁移：v3 → v4（本地线程标题来源列，U4）', () => {
  it('存量 v3 库升级：title_source 补列且存量行默认 derived，标题与行数不丢', async () => {
    const db = new MemorySqlDriver();
    // 只跑到 v3（真实迁移数组前三项），构造存量库
    await migrateIfNeeded(db, MIGRATIONS.slice(0, 3));
    await expect(db.getFirst('PRAGMA user_version')).resolves.toEqual({
      user_version: 3,
    });
    // v3 形态写入（列清单不含 title_source）
    await db.exec(
      'INSERT INTO local_threads (id, title, preview, provider_id, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['t1', '旧线程标题', '摘要', 'p1', 'm1', 100, 200]
    );
    await db.exec(
      'INSERT INTO local_threads (id, title, preview, provider_id, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['t2', '另一线程', '', null, null, 300, 400]
    );

    // 迁移器恒升到最新版（v5 起含 local_messages 附件列）；本用例的
    // v4 语义由下方 title_source 断言钉住，版本数随迁移数组演进
    await expect(migrateIfNeeded(db)).resolves.toBe(LATEST_VERSION);
    expect(db.rowCount('local_threads')).toBe(2);
    const rows = await db.getAll<{
      id: string;
      title: string;
      title_source: string;
    }>('SELECT id, title, title_source FROM local_threads ORDER BY id ASC');
    expect(rows).toEqual([
      { id: 't1', title: '旧线程标题', title_source: 'derived' },
      { id: 't2', title: '另一线程', title_source: 'derived' },
    ]);
    // 升级后新写入可携带显式来源（v4 形态 INSERT 全列）
    await db.exec(
      'INSERT INTO local_threads (id, title, title_source, preview, provider_id, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['t3', '新线程', 'ai', '', null, null, 500, 500]
    );
    const t3 = await db.getFirst<{ title_source: string }>(
      'SELECT title_source FROM local_threads WHERE id = ?',
      ['t3']
    );
    expect(t3?.title_source).toBe('ai');
  });
});

describe('迁移：版本一致性护栏', () => {
  it('MIGRATIONS 长度与 SCHEMA_VERSION 一致（不一致会抛错）', () => {
    expect(LATEST_VERSION).toBe(SCHEMA_VERSION);
  });
});

describe('迁移：防御性读取（db.ts 兜底分支）', () => {
  it('PRAGMA user_version 读取返回 null（驱动异常面）→ 视为 v0 从零迁移', async () => {
    const db = new MemorySqlDriver();
    // 包裹驱动：版本读取返回 null，其余透传（防御性兜底 `row?.user_version ?? 0`）
    const wrapped = new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === 'getFirst') {
          return async (sql: string, params?: readonly unknown[]) => {
            if (String(sql).includes('user_version')) return null;
            return target.getFirst(sql as never, params);
          };
        }
        return value;
      },
    });
    const version = await migrateIfNeeded(wrapped);
    expect(version).toBe(LATEST_VERSION);
    await expect(db.getFirst('PRAGMA user_version')).resolves.toEqual({
      user_version: LATEST_VERSION,
    });
  });
});
