// 数据库入口（M5 §5.4 / §2.1 db.ts）：迁移执行 + 真实环境接线点
// 纪律（M5 §5.4）：迁移只追加不改写；幂等重复执行不报错；业务数据保留。
import type { SqlDriver } from './driver';
import { MIGRATIONS, type Migration } from './migrations';

/**
 * 迁移执行（M5 §5.4 migrateIfNeeded 形态，注入 driver 便于 jest 内存 mock 验证）：
 * - 读取 PRAGMA user_version 得到当前版本；
 * - 从当前版本逐级执行迁移 SQL（每级一个事务），完成后置 user_version = v + 1；
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
  for (let v = current; v < migrations.length; v++) {
    const migration = migrations[v]!;
    await db.withTransaction(async () => {
      for (const sql of migration.sql) {
        await db.exec(sql);
      }
      await db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
  return Math.max(current, migrations.length);
}

/**
 * 真实环境接线点（expo-sqlite，注入适配后供 app 层调用；jest 环境使用 MemorySqlDriver）：
 *
 * ```ts
 * // app/_layout.tsx（M5 §2.1：SQLiteProvider onInit）
 * import { openDatabaseAsync } from 'expo-sqlite';
 * import { expoSqliteDriver } from '../src/db/db';
 *
 * const db = await openDatabaseAsync('crish-mobile.db');
 * await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
 * await migrateIfNeeded(expoSqliteDriver(db));
 * ```
 *
 * expo-sqlite 适配器（依赖安装后启用，D8 门禁：expo-sqlite ~57.0.1）：
 * ```ts
 * export function expoSqliteDriver(db: SQLiteDatabase): SqlDriver {
 *   return {
 *     async exec(sql, params) { await db.execAsync(sql, params as any[]); },
 *     async getFirst(sql, params) { return db.getFirstAsync(sql, params as any[]); },
 *     async getAll(sql, params) { return db.getAllAsync(sql, params as any[]); },
 *     async withTransaction(fn) { return db.withTransactionAsync(fn); },
 *   };
 * }
 * ```
 */
