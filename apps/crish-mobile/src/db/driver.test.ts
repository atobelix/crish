// MemorySqlDriver 迷你 SQL 引擎自检（R2-13：内存 mock 实现的行为契约）
// 目的：测试用 SQL 与真实 SQLite 语义对齐的保证（fail-fast 子集 + 关键行为断言）。
import { MemorySqlDriver } from './driver';

/** 建一张测试表（含复合主键/唯一约束/CHECK 忽略） */
async function setup(db: MemorySqlDriver): Promise<void> {
  await db.exec(`CREATE TABLE IF NOT EXISTS demo (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    seq INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    label TEXT,
    ts INTEGER,
    UNIQUE (session_id, seq)
  )`);
}

describe('MemorySqlDriver 建表与元数据', () => {
  it('CREATE TABLE IF NOT EXISTS 幂等（重复执行不报错）', async () => {
    const db = new MemorySqlDriver();
    await setup(db);
    await setup(db);
    expect(db.listTables()).toEqual(['demo']);
  });

  it('CREATE INDEX 忽略不报错', async () => {
    const db = new MemorySqlDriver();
    await setup(db);
    await expect(
      db.exec('CREATE INDEX IF NOT EXISTS idx_demo ON demo(ts DESC)')
    ).resolves.toBeUndefined();
  });

  it('DROP TABLE 不存在的表抛错（fail-fast）', async () => {
    const db = new MemorySqlDriver();
    await setup(db);
    await expect(db.exec('DROP TABLE missing_table')).rejects.toThrow(
      '表不存在'
    );
    // DROP TABLE IF EXISTS 幂等（v2 幽灵表清理语义）
    await expect(
      db.exec('DROP TABLE IF EXISTS missing_table')
    ).resolves.toBeUndefined();
    // 未登记前缀仍 fail-fast
    await expect(db.exec('VACUUM')).rejects.toThrow('不支持的 SQL 前缀');
  });

  it('不存在的表抛错', async () => {
    const db = new MemorySqlDriver();
    await expect(db.getAll('SELECT * FROM ghost')).rejects.toThrow('表不存在');
  });
});

describe('MemorySqlDriver PRAGMA user_version', () => {
  it('默认 0，可读写', async () => {
    const db = new MemorySqlDriver();
    await expect(db.getFirst('PRAGMA user_version')).resolves.toEqual({
      user_version: 0,
    });
    await db.exec('PRAGMA user_version = 2');
    await expect(db.getFirst('PRAGMA user_version')).resolves.toEqual({
      user_version: 2,
    });
  });
});

describe('MemorySqlDriver INSERT / SELECT', () => {
  it('插入与全量查询往返（INTEGER 转 number）', async () => {
    const db = new MemorySqlDriver();
    await setup(db);
    await db.exec(
      'INSERT INTO demo (id, session_id, seq, status, label, ts) VALUES (?, ?, ?, ?, ?, ?)',
      ['a1', 's1', 1, 'open', '第一条', 100]
    );
    const rows = await db.getAll<Record<string, unknown>>('SELECT * FROM demo');
    expect(rows).toEqual([
      {
        id: 'a1',
        session_id: 's1',
        seq: 1,
        status: 'open',
        label: '第一条',
        ts: 100,
      },
    ]);
  });

  it('主键冲突抛错；唯一约束冲突抛错', async () => {
    const db = new MemorySqlDriver();
    await setup(db);
    await db.exec('INSERT INTO demo (id, session_id, seq) VALUES (?, ?, ?)', [
      'a1',
      's1',
      1,
    ]);
    await expect(
      db.exec('INSERT INTO demo (id, session_id, seq) VALUES (?, ?, ?)', [
        'a1',
        's2',
        2,
      ])
    ).rejects.toThrow('主键冲突');
    await expect(
      db.exec('INSERT INTO demo (id, session_id, seq) VALUES (?, ?, ?)', [
        'a2',
        's1',
        1,
      ])
    ).rejects.toThrow('唯一约束冲突');
  });

  it('WHERE 条件：等值/比较/IN/IS NULL/AND 组合', async () => {
    const db = new MemorySqlDriver();
    await setup(db);
    await db.exec(
      'INSERT INTO demo (id, session_id, seq, ts) VALUES (?, ?, ?, ?)',
      ['a1', 's1', 1, 100]
    );
    await db.exec(
      'INSERT INTO demo (id, session_id, seq, ts) VALUES (?, ?, ?, ?)',
      ['a2', 's1', 2, 200]
    );
    await db.exec(
      'INSERT INTO demo (id, session_id, seq, ts) VALUES (?, ?, ?, ?)',
      ['a3', 's2', 5, null]
    );
    const eq = await db.getAll<{ id: string }>(
      "SELECT id FROM demo WHERE session_id = 's1'"
    );
    expect(eq.map((r) => r.id)).toEqual(['a1', 'a2']);
    const gt = await db.getAll<{ id: string }>(
      'SELECT id FROM demo WHERE seq > ? AND ts >= ?',
      [1, 100]
    );
    expect(gt.map((r) => r.id)).toEqual(['a2']);
    const inRows = await db.getAll<{ id: string }>(
      'SELECT id FROM demo WHERE seq IN (1, 5)'
    );
    expect(inRows.map((r) => r.id)).toEqual(['a1', 'a3']);
    const nullRows = await db.getAll<{ id: string }>(
      'SELECT id FROM demo WHERE ts IS NULL'
    );
    expect(nullRows.map((r) => r.id)).toEqual(['a3']);
  });

  it('WHERE 括号 + OR 分组（重放扫描同形态）', async () => {
    const db = new MemorySqlDriver();
    await setup(db);
    await db.exec(
      'INSERT INTO demo (id, session_id, seq, status) VALUES (?, ?, ?, ?)',
      ['a1', 's1', 1, 'pending']
    );
    await db.exec(
      'INSERT INTO demo (id, session_id, seq, status, ts) VALUES (?, ?, ?, ?, ?)',
      ['a2', 's1', 2, 'failed', 50]
    );
    await db.exec(
      'INSERT INTO demo (id, session_id, seq, status, ts) VALUES (?, ?, ?, ?, ?)',
      ['a3', 's1', 3, 'failed', 200]
    );
    const rows = await db.getAll<{ id: string }>(
      "SELECT id FROM demo WHERE status = 'pending' OR (status = 'failed' AND ts <= ?) ORDER BY seq ASC",
      [100]
    );
    expect(rows.map((r) => r.id)).toEqual(['a1', 'a2']);
  });

  it('ORDER BY 多列 + LIMIT + OFFSET 分页', async () => {
    const db = new MemorySqlDriver();
    await setup(db);
    for (let i = 1; i <= 5; i++) {
      await db.exec(
        'INSERT INTO demo (id, session_id, seq, ts) VALUES (?, ?, ?, ?)',
        [`a${i}`, 's1', i, i * 10]
      );
    }
    const page2 = await db.getAll<{ id: string }>(
      'SELECT id FROM demo ORDER BY seq DESC LIMIT ? OFFSET ?',
      [2, 2]
    );
    expect(page2.map((r) => r.id)).toEqual(['a3', 'a2']);
  });

  it('DISTINCT 去重（清理计算用）', async () => {
    const db = new MemorySqlDriver();
    await setup(db);
    await db.exec('INSERT INTO demo (id, session_id, seq) VALUES (?, ?, ?)', [
      'a1',
      's1',
      1,
    ]);
    await db.exec('INSERT INTO demo (id, session_id, seq) VALUES (?, ?, ?)', [
      'a2',
      's1',
      2,
    ]);
    await db.exec('INSERT INTO demo (id, session_id, seq) VALUES (?, ?, ?)', [
      'a3',
      's2',
      3,
    ]);
    const rows = await db.getAll<{ session_id: string }>(
      'SELECT DISTINCT session_id FROM demo'
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.session_id).sort()).toEqual(['s1', 's2']);
  });

  it('聚合：COUNT(*) / MAX(列)', async () => {
    const db = new MemorySqlDriver();
    await setup(db);
    await db.exec(
      'INSERT INTO demo (id, session_id, seq, ts) VALUES (?, ?, ?, ?)',
      ['a1', 's1', 1, 100]
    );
    await db.exec(
      'INSERT INTO demo (id, session_id, seq, ts) VALUES (?, ?, ?, ?)',
      ['a2', 's1', 2, 200]
    );
    await expect(
      db.getFirst<{ count: number }>('SELECT COUNT(*) AS count FROM demo')
    ).resolves.toEqual({ count: 2 });
    await expect(
      db.getFirst<{ max: number }>(
        'SELECT MAX(ts) AS max FROM demo WHERE session_id = ?',
        ['s1']
      )
    ).resolves.toEqual({ max: 200 });
    await expect(
      db.getFirst<{ count: number }>(
        'SELECT COUNT(*) AS count FROM demo WHERE session_id = ?',
        ['ghost']
      )
    ).resolves.toEqual({ count: 0 });
  });
});

describe('MemorySqlDriver UPDATE / DELETE / 事务', () => {
  it('UPDATE 按条件更新，NULL 值支持', async () => {
    const db = new MemorySqlDriver();
    await setup(db);
    await db.exec(
      'INSERT INTO demo (id, session_id, seq, status) VALUES (?, ?, ?, ?)',
      ['a1', 's1', 1, 'pending']
    );
    await db.exec(
      'UPDATE demo SET status = ?, label = NULL, ts = ? WHERE id = ?',
      ['failed', 999, 'a1']
    );
    const row = await db.getFirst<{
      status: string;
      label: unknown;
      ts: number;
    }>('SELECT * FROM demo WHERE id = ?', ['a1']);
    expect(row).toMatchObject({ status: 'failed', label: null, ts: 999 });
  });

  it('DELETE 按条件 / 全删', async () => {
    const db = new MemorySqlDriver();
    await setup(db);
    await db.exec('INSERT INTO demo (id, session_id, seq) VALUES (?, ?, ?)', [
      'a1',
      's1',
      1,
    ]);
    await db.exec('INSERT INTO demo (id, session_id, seq) VALUES (?, ?, ?)', [
      'a2',
      's2',
      2,
    ]);
    await db.exec("DELETE FROM demo WHERE session_id = 's1'");
    expect(db.rowCount('demo')).toBe(1);
    await db.exec('DELETE FROM demo');
    expect(db.rowCount('demo')).toBe(0);
  });

  it('NOT IN 列表删除（会话清理同形态）', async () => {
    const db = new MemorySqlDriver();
    await setup(db);
    for (let i = 1; i <= 5; i++) {
      await db.exec('INSERT INTO demo (id, session_id, seq) VALUES (?, ?, ?)', [
        `a${i}`,
        `s${i}`,
        i,
      ]);
    }
    await db.exec('DELETE FROM demo WHERE id NOT IN (?, ?, ?)', [
      'a4',
      'a5',
      'a2',
    ]);
    expect(db.rowCount('demo')).toBe(3);
  });

  it('withTransaction 深度成对维护', async () => {
    const db = new MemorySqlDriver();
    await setup(db);
    expect(db.getTransactionDepth()).toBe(0);
    await db.withTransaction(async () => {
      expect(db.getTransactionDepth()).toBe(1);
      await db.exec('INSERT INTO demo (id, session_id, seq) VALUES (?, ?, ?)', [
        'a1',
        's1',
        1,
      ]);
    });
    expect(db.getTransactionDepth()).toBe(0);
    expect(db.rowCount('demo')).toBe(1);
  });
});
