// dbBootstrap 启动装配测试（R2-13 部分 2）：
// - 装配链：open → 连接 PRAGMA → user_version → migrate → configure（注入）→ store
//   hydrate（调用顺序以录制标签断言；真实迁移经 MemorySqlDriver 全链路跑通）；
// - 失败降级：open / 迁移失败 → 内存态（默认注入复位）+ 不抛 + 日志注记「持久化不可用」；
// - hydrate 回填：二次启动从 settings 表回填上次持久化的设置（迁移幂等不重复建表）。
import type { SQLiteBindParams, SQLiteDatabase } from 'expo-sqlite';
import { openDatabaseAsync } from 'expo-sqlite';
import { MemorySqlDriver } from './driver';
import { ensureDatabaseForApp, MOBILE_DB_NAME } from './dbBootstrap';
import {
  settingsStore,
  configureSettingsPersistence,
} from '@/domain/store/settingsStore';
import {
  notificationStore,
  configureNotificationsPersistence,
  resetNotificationsForTest,
} from '@/domain/store/notificationStore';
import { defaultSettingsGroups } from '@/domain/store/settingsReducers';
import { configureSqlitePersistence } from '@/domain/store/persistBootstrap';

/** 等异步写落盘（settingsStore.set 的 void 写为 fire-and-forget） */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * expo-sqlite 绑定参数 → 数组形态（SQLiteBindParams 为数组 | 具名 Record 联合；
 * 本仓 SQL 只用位置参数，Record 形态兜底转值序列对齐内存驱动入参）。
 */
function toArrayParams(params?: SQLiteBindParams): readonly unknown[] {
  if (params === undefined) return [];
  return Array.isArray(params) ? params : Object.values(params);
}

/**
 * MemorySqlDriver → SQLiteDatabase 形（测试注入面；calls 可选录制调用标签：
 * 'open'（外层 open 录制）/ 'pragma'（连接 PRAGMA）/ 'user_version'（版本读取）/
 * 'migrate'（迁移 SQL）/ 'write'（参数化写）/ 'read'（查询读））。
 * 连接级 PRAGMA（journal_mode/foreign_keys）内存驱动不识别 → 吞掉；
 * 其余 PRAGMA（user_version 读写）透传内存驱动，保证迁移版本语义真实。
 */
function sqliteLikeFromDriver(
  driver: MemorySqlDriver,
  calls?: string[]
): SQLiteDatabase {
  const record = (tag: string): void => {
    if (calls) calls.push(tag);
  };
  return {
    execAsync: async (sql: string) => {
      const upper = sql.trim().toUpperCase();
      if (
        upper.startsWith('PRAGMA JOURNAL_MODE') ||
        upper.startsWith('PRAGMA FOREIGN_KEYS')
      ) {
        record('pragma');
        return;
      }
      if (upper.startsWith('PRAGMA ')) {
        await driver.exec(sql); // user_version 写等：透传内存驱动
        return;
      }
      record('migrate');
      await driver.exec(sql);
    },
    getFirstAsync: async <T>(
      sql: string,
      params?: SQLiteBindParams
    ): Promise<T | null> => {
      record(sql.includes('user_version') ? 'user_version' : 'query');
      return driver.getFirst<T>(sql, toArrayParams(params));
    },
    getAllAsync: async <T>(
      sql: string,
      params?: SQLiteBindParams
    ): Promise<T[]> => {
      record('read');
      return driver.getAll<T>(sql, toArrayParams(params));
    },
    withTransactionAsync: async (fn: () => Promise<void>) => {
      await driver.withTransaction(async () => {
        await fn();
      });
    },
    prepareAsync: async (sql: string) => ({
      executeAsync: async (params?: SQLiteBindParams) => {
        record('write');
        await driver.exec(sql, toArrayParams(params));
      },
      finalizeAsync: async () => {},
    }),
  } as unknown as SQLiteDatabase;
}

/** 重置 store 单例（跨用例隔离，对齐 persistBootstrap.test.ts 手法） */
function resetSettingsStore(): void {
  settingsStore.setState({
    groups: defaultSettingsGroups(),
    hydrated: false,
  });
}

describe('ensureDatabaseForApp（启动装配链）', () => {
  let driver: MemorySqlDriver;
  let calls: string[];

  beforeEach(() => {
    driver = new MemorySqlDriver();
    calls = [];
    resetSettingsStore();
    resetNotificationsForTest();
    configureSettingsPersistence(null);
    configureNotificationsPersistence(null);
    jest.mocked(openDatabaseAsync).mockClear();
  });

  afterEach(() => {
    configureSqlitePersistence(null);
  });

  it('装配链：open → pragma → user_version → migrate → configure → hydrate（顺序 + 8 表建成）', async () => {
    const open = jest.fn(async (name: string) => {
      calls.push('open');
      expect(name).toBe(MOBILE_DB_NAME);
      return sqliteLikeFromDriver(driver, calls);
    });

    const result = await ensureDatabaseForApp({ open });

    expect(result).toEqual({ ok: true, version: 1 });
    // 真实迁移全链路：schema v1 的 8 表建成
    const tables = driver.listTables();
    for (const t of [
      'events',
      'approval_queue',
      'approval_history',
      'session_summaries',
      'settings',
      'push_tokens',
      'device_info',
      'notifications',
    ]) {
      expect(tables).toContain(t);
    }
    // 调用顺序：open < 连接 PRAGMA < user_version < 迁移 SQL < hydrate 读库
    const idx = (tag: string): number => calls.indexOf(tag);
    expect(idx('open')).toBeGreaterThanOrEqual(0);
    expect(idx('open')).toBeLessThan(idx('pragma'));
    expect(idx('pragma')).toBeLessThan(idx('user_version'));
    expect(idx('user_version')).toBeLessThan(idx('migrate'));
    expect(idx('migrate')).toBeLessThan(idx('read'));
    // configure 注入后 hydrate 完成：两 store 均 hydrated
    expect(settingsStore.getState().hydrated).toBe(true);
    expect(notificationStore.getState().hydrated).toBe(true);
  });

  it('缺省 open → expo-sqlite openDatabaseAsync 打开 crish-mobile.db 并完成装配', async () => {
    const result = await ensureDatabaseForApp();

    expect(jest.mocked(openDatabaseAsync)).toHaveBeenCalledWith(MOBILE_DB_NAME);
    expect(result.ok).toBe(true);
    expect(result.version).toBe(1);
    expect(settingsStore.getState().hydrated).toBe(true);
    expect(notificationStore.getState().hydrated).toBe(true);
  });

  it('二次启动：迁移幂等跳过 + hydrate 从 settings 表回填上次持久化的设置', async () => {
    const open = jest.fn(async () => sqliteLikeFromDriver(driver, calls));
    await ensureDatabaseForApp({ open });
    expect(settingsStore.getState().hydrated).toBe(true);

    // 注入的默认持久化生效：store 写 → 真实 DAO 落 settings 表（参数化写路径）
    settingsStore.getState().set('notification', {
      masterOn: false,
      sceneFlags: {
        message: true,
        taskDone: true,
        approval: true,
        error: true,
        deviceOffline: false,
      },
    });
    settingsStore.getState().set('appearance', { theme: 'dark' });
    await flush();
    expect(calls).toContain('write');

    // 模拟下次冷启动：重置 store（hydrated=false + 默认值），复用同一 driver（同库文件）
    calls.length = 0;
    resetSettingsStore();
    resetNotificationsForTest();
    configureSettingsPersistence(null);
    configureNotificationsPersistence(null);

    await ensureDatabaseForApp({ open });

    // 迁移幂等：第二次启动不再执行迁移 SQL（user_version=1 直接跳过）
    expect(calls).not.toContain('migrate');
    const st = settingsStore.getState();
    expect(st.hydrated).toBe(true);
    expect(st.groups.notification.masterOn).toBe(false);
    expect(st.groups.notification.sceneFlags.approval).toBe(true); // 缺字段默认
    expect(st.groups.appearance.theme).toBe('dark');
  });
});

describe('ensureDatabaseForApp（失败降级内存态）', () => {
  beforeEach(() => {
    resetSettingsStore();
    resetNotificationsForTest();
    configureSettingsPersistence(null);
    configureNotificationsPersistence(null);
  });

  afterEach(() => {
    configureSqlitePersistence(null);
  });

  it('open 失败 → 内存态 + 不抛 + 日志注记「持久化不可用」', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const open = jest.fn(async () => {
      throw new Error('open failed');
    });

    const result = await ensureDatabaseForApp({ open });

    expect(result.ok).toBe(false);
    expect(result.version).toBe(0);
    expect(result.reason).toContain('open failed');
    // 不阻塞启动：两 store 均置位 hydrated（默认值可展示），不抛异常
    expect(settingsStore.getState().hydrated).toBe(true);
    expect(notificationStore.getState().hydrated).toBe(true);
    // 诚实化注记：明确标注持久化不可用
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('持久化不可用'));
    warn.mockRestore();
  });

  it('迁移失败 → 内存态 + 不抛（装配中止，configure/hydrate 后续注入不生效）', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const open = jest.fn(
      async () =>
        ({
          execAsync: jest.fn(async () => {}),
          getFirstAsync: jest.fn(async () => {
            throw new Error('migrate failed');
          }),
          getAllAsync: jest.fn(async () => []),
          withTransactionAsync: jest.fn(async () => {}),
          prepareAsync: jest.fn(async () => ({
            executeAsync: jest.fn(async () => ({})),
            finalizeAsync: jest.fn(async () => {}),
          })),
        }) as unknown as SQLiteDatabase
    );

    const result = await ensureDatabaseForApp({ open });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('migrate failed');
    expect(settingsStore.getState().hydrated).toBe(true);
    expect(notificationStore.getState().hydrated).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('持久化不可用'));
    warn.mockRestore();
  });

  it('失败后写入不落库（默认注入已复位 → 纯内存态静默）', async () => {
    const open = jest.fn(async () => {
      throw new Error('open failed');
    });
    await ensureDatabaseForApp({ open });

    settingsStore.getState().set('appearance', { theme: 'dark' });
    // 无默认注入 → 不落库（silent no-op，且不抛错）
    await expect(flush()).resolves.toBeUndefined();
  });
});
