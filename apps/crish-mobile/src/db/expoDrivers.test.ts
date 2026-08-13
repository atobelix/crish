// 真实驱动接线点测试（R-3）：expoSecureStoreDriver / expoSqlDriver 的 API 映射断言
// - mock 方案：jest.setup.ts 全局 mock expo-secure-store（内存 Map，M5 §10.4.5）与
//   expo-sqlite；本文件直接以真实接口形态调用驱动工厂，断言方法映射与参数透传；
// - expoSqlDriver 用 fake SQLiteDatabase（jest.fn 记录调用面），覆盖无参/带参 exec
//   双路径（SDK 57 execAsync 不支持参数 → 参数化走 prepareAsync+executeAsync）。
import * as SecureStore from 'expo-secure-store';
import type { SQLiteDatabase } from 'expo-sqlite';
import {
  clearPairing,
  expoSecureStoreDriver,
  loadPairingCredential,
  savePairingCredential,
} from './secureStore';
import { expoSqlDriver } from './db';

describe('expoSecureStoreDriver（映射 expo-secure-store 三方法）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('setItem → SecureStore.setItemAsync(key, value)', async () => {
    const driver = expoSecureStoreDriver();
    await driver.setItem('pair.token_key', 'tk-1');
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      'pair.token_key',
      'tk-1'
    );
  });

  it('getItem → SecureStore.getItemAsync(key)；已写值可读回，缺失返回 null', async () => {
    const driver = expoSecureStoreDriver();
    await driver.setItem('pair.token_key', 'tk-1');
    expect(await driver.getItem('pair.token_key')).toBe('tk-1');
    expect(await driver.getItem('pair.missing')).toBeNull();
    expect(SecureStore.getItemAsync).toHaveBeenCalledWith('pair.token_key');
  });

  it('deleteItem → SecureStore.deleteItemAsync(key)；删除后读回 null（不存在静默）', async () => {
    const driver = expoSecureStoreDriver();
    await driver.setItem('pair.exchange_nonce', 'n-1');
    await driver.deleteItem('pair.exchange_nonce');
    expect(await driver.getItem('pair.exchange_nonce')).toBeNull();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(
      'pair.exchange_nonce'
    );
    // 删除不存在键静默成功（对齐 expo-secure-store 语义）
    await expect(
      driver.deleteItem('pair.never-exists')
    ).resolves.toBeUndefined();
  });

  it('批量配对凭据读写链路（savePairingCredential → loadPairingCredential 经真实驱动）', async () => {
    const driver = expoSecureStoreDriver();
    await savePairingCredential(driver, {
      tokenKey: 'tk',
      refreshKey: 'rk',
      deviceKeypairPriv: 'priv',
      deviceKeypairPub: 'pub',
      hostFingerprint: 'fp',
    });
    const cred = await loadPairingCredential(driver);
    expect(cred).toMatchObject({
      tokenKey: 'tk',
      refreshKey: 'rk',
      deviceKeypairPriv: 'priv',
      deviceKeypairPub: 'pub',
      hostFingerprint: 'fp',
    });
    await clearPairing(driver);
    expect(await loadPairingCredential(driver)).toBeNull();
  });
});

describe('expoSqlDriver（映射 expo-sqlite 方法面）', () => {
  /** fake SQLiteDatabase：jest.fn 记录调用面（类型经 unknown 收敛） */
  function makeFakeDb() {
    const statement = {
      executeAsync: jest.fn(async () => ({})),
      finalizeAsync: jest.fn(async () => {}),
    };
    const fake = {
      execAsync: jest.fn(async () => {}),
      getFirstAsync: jest.fn(async <T>() => ({ value: 'v1' }) as T),
      getAllAsync: jest.fn(async <T>() => [{ value: 'v1' } as T]),
      withTransactionAsync: jest.fn(async (task: () => Promise<void>) => {
        await task();
      }),
      prepareAsync: jest.fn(async () => statement),
    };
    return {
      fake,
      db: fake as unknown as SQLiteDatabase,
      statement,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('exec 无参数 → execAsync(sql)（迁移多语句路径，不建 prepared statement）', async () => {
    const { fake, db } = makeFakeDb();
    const driver = expoSqlDriver(db);
    await driver.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)');
    expect(fake.execAsync).toHaveBeenCalledWith(
      'CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)'
    );
    expect(fake.prepareAsync).not.toHaveBeenCalled();
  });

  it('exec 带参数 → prepareAsync + executeAsync(params) + finalizeAsync（SDK 57 参数化路径）', async () => {
    const { fake, db } = makeFakeDb();
    const driver = expoSqlDriver(db);
    await driver.exec('INSERT INTO settings (key, value) VALUES (?, ?)', [
      'k1',
      'v1',
    ]);
    expect(fake.execAsync).not.toHaveBeenCalled();
    expect(fake.prepareAsync).toHaveBeenCalledWith(
      'INSERT INTO settings (key, value) VALUES (?, ?)'
    );
    const statement = await fake.prepareAsync.mock.results[0]!.value;
    expect(statement.executeAsync).toHaveBeenCalledWith(['k1', 'v1']);
    expect(statement.finalizeAsync).toHaveBeenCalled();
  });

  it('exec 带参数且语句失败 → 仍 finalize（finally 语义）', async () => {
    const { fake, db, statement } = makeFakeDb();
    const failingStatement = {
      ...statement,
      executeAsync: jest.fn(async () => {
        throw new Error('约束冲突');
      }),
    };
    fake.prepareAsync.mockImplementationOnce(async () => failingStatement);
    const driver = expoSqlDriver(db);
    await expect(
      driver.exec('INSERT INTO t VALUES (?)', ['x'])
    ).rejects.toThrow('约束冲突');
    expect(failingStatement.finalizeAsync).toHaveBeenCalled();
  });

  it('getFirst / getAll → 透传 SQL 与参数，返回行透传', async () => {
    const { fake, db } = makeFakeDb();
    const driver = expoSqlDriver(db);
    const row = await driver.getFirst<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?',
      ['k1']
    );
    expect(fake.getFirstAsync).toHaveBeenCalledWith(
      'SELECT value FROM settings WHERE key = ?',
      ['k1']
    );
    expect(row).toEqual({ value: 'v1' });

    const rows = await driver.getAll<{ value: string }>(
      'SELECT value FROM settings'
    );
    expect(fake.getAllAsync).toHaveBeenCalledWith(
      'SELECT value FROM settings',
      []
    );
    expect(rows).toEqual([{ value: 'v1' }]);
  });

  it('withTransaction → 事务内执行 fn 并返回其值；异常透传（回滚语义归 expo-sqlite）', async () => {
    const { fake, db } = makeFakeDb();
    const driver = expoSqlDriver(db);
    const result = await driver.withTransaction(async () => {
      await driver.exec('UPDATE t SET v = 1');
      return 42;
    });
    expect(result).toBe(42);
    expect(fake.withTransactionAsync).toHaveBeenCalledTimes(1);
  });
});
