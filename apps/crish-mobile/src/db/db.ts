// 数据库入口（M5 §5.4 / §2.1 db.ts）：迁移执行 + 真实环境接线点
// 纪律（M5 §5.4）：迁移只追加不改写；幂等重复执行不报错；业务数据保留。
// R-3 落地：expoSqlDriver 为真实环境适配器（expo-sqlite ~57.0.1）；仅类型导入，
// 运行时由调用方（app 层 SQLiteProvider / openDatabaseAsync）传入 SQLiteDatabase。
import type { SQLiteDatabase, SQLiteBindParams } from 'expo-sqlite';
import type { SqlDriver } from './driver';
import { MIGRATIONS, type Migration } from './migrations';

/**
 * 迁移执行（M5 §5.4 migrateIfNeeded 形态，注入 driver 便于 jest 内存 mock 验证）：
 * - 读取 PRAGMA user_version 得到当前版本；
 * - 降级防御：本地版本高于迁移数组（旧版 APK 装到高版本库）→ 抛错拒绝打开，
 *   杜绝结构不匹配静默运行；
 * - 从当前版本逐级执行迁移 SQL（每级一个事务，PRAGMA user_version 在事务提交后
 *   单独执行——SQLite 规范：元数据 PRAGMA 在活动事务内不保证原子/持久化）；
 * - 重复执行幂等：版本已到最新则跳过（不重复建表、不动业务数据）；
 * - 全新库（v0）直达最新。
 * @returns 迁移后的版本号
 */
export async function migrateIfNeeded(
  db: SqlDriver,
  migrations: readonly Migration[] = MIGRATIONS
): Promise<number> {
  const row = await db.getFirst<{ user_version: number }>(
    'PRAGMA user_version'
  );
  const current = row?.user_version ?? 0;
  if (current > migrations.length) {
    throw new Error(
      `数据库版本高于应用迁移目标（local=${current} target=${migrations.length}），禁止降级运行`
    );
  }
  for (let v = current; v < migrations.length; v++) {
    const migration = migrations[v]!;
    await db.withTransaction(async () => {
      for (const sql of migration.sql) {
        await db.exec(sql);
      }
    });
    // 版本推进在事务提交后单独执行：元数据 PRAGMA 在活动事务内不保证原子/持久化
    await db.exec(`PRAGMA user_version = ${v + 1}`);
  }
  return Math.max(current, migrations.length);
}

/**
 * 真实环境接线点（R-3 落地）：expo-sqlite 适配器，SQL 语义对齐 MemorySqlDriver 子集——
 * - exec：无参数走 execAsync（多语句迁移 SQL）；带参数走 prepareAsync + executeAsync +
 *   finalizeAsync（SDK 57 execAsync 不支持参数绑定，参数化语句必须经 prepared statement）；
 * - getFirst/getAll：透传 getFirstAsync/getAllAsync（含参数数组）；
 * - withTransaction：透传 withTransactionAsync（fn 的返回值经事务内捕获返回，
 *   失败自动回滚并传播异常，对齐 MemorySqlDriver 语义）。
 * 调用形态（app 层接线，M5 §2.1：SQLiteProvider onInit 或启动装配）：
 *
 * ```ts
 * import { openDatabaseAsync } from 'expo-sqlite';
 * import { expoSqlDriver, migrateIfNeeded } from '@/db';
 * const db = await openDatabaseAsync('crish-mobile.db');
 * await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
 * await migrateIfNeeded(expoSqlDriver(db));
 * ```
 */
export function expoSqlDriver(db: SQLiteDatabase): SqlDriver {
  return {
    async exec(sql, params) {
      if (params === undefined || params.length === 0) {
        await db.execAsync(sql);
        return;
      }
      const statement = await db.prepareAsync(sql);
      try {
        await statement.executeAsync(params as SQLiteBindParams);
      } finally {
        await statement.finalizeAsync();
      }
    },
    async getFirst(sql, params) {
      return db.getFirstAsync(sql, (params ?? []) as SQLiteBindParams);
    },
    async getAll(sql, params) {
      return db.getAllAsync(sql, (params ?? []) as SQLiteBindParams);
    },
    async withTransaction(fn) {
      let result!: Awaited<ReturnType<typeof fn>>;
      await db.withTransactionAsync(async () => {
        result = await fn();
      });
      return result;
    },
  };
}
