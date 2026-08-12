// 迁移数组（M5 §5.4：有序 [v1, v2, …]，每项为「迁移名 + SQL 列表」）
// 迁移纪律（M5 §5.4）：
// - 只追加不改写：已发布迁移 SQL 禁止修改，新需求走 v2+；
// - 业务数据保留：迁移不删表不清库（「移除本机」也保留 SQLite，D4 §5.8）；
// - 幂等测试：覆盖「从 v0 逐级升到最新」与「重复执行不报错」。
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema';

/** 单个迁移：name 为迁移名，sql 为按序执行的 SQL 列表 */
export interface Migration {
  /** 迁移名（如 v1-initial） */
  name: string;
  /** 迁移 SQL（逐条在事务内执行） */
  sql: readonly string[];
}

/**
 * 迁移数组：下标 v = 目标 user_version - 1（M5 §5.4 的 migrations[v] 执行后置 user_version = v+1）。
 * 未来新增迁移在此数组末尾追加，禁止修改既有项。
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    name: 'v1-initial',
    sql: SCHEMA_SQL,
  },
];

/** 迁移目标版本（= 迁移数组长度，应与 schema 版本一致） */
export const LATEST_VERSION = MIGRATIONS.length;

// 一致性断言：迁移目标版本必须等于 schema 声明的版本（防改 schema 忘加迁移）
if (LATEST_VERSION !== SCHEMA_VERSION) {
  throw new Error(
    `迁移版本与 schema 版本不一致：MIGRATIONS=${LATEST_VERSION} SCHEMA_VERSION=${SCHEMA_VERSION}`
  );
}
