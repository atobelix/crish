/**
 * v6 数据库迁移：网页搜索与沙箱工具体系集成
 *
 * 依据架构方案：docs/mobile-web-search-and-sandbox/06-分维-状态机演进与SQLite持久化及设置方案.md §3
 *
 * 核心目标：
 * 为 local_messages 单表原子追加 5 个可空 JSON 文本列：
 * - tool_calls_json TEXT DEFAULT NULL
 * - tool_results_json TEXT DEFAULT NULL
 * - citations_json TEXT DEFAULT NULL
 * - search_state_json TEXT DEFAULT NULL
 * - server_diagnostics_json TEXT DEFAULT NULL
 *
 * 遵循架构红线：
 * 1. 坚决反过度设计（Anti-Overengineering）：单表单行高内聚聚合根存储，杜绝关系化拆表与多表 JOIN 损耗；
 * 2. 凭据绝对物理隔离（Zero-Leak）：绝不允许任何 API Key 或敏感 Token 落入本列；
 * 3. 幂等性守卫：先检查列是否存在，避免重复执行抛错。
 */
import type { SqlDriver } from '../driver';

/** v6 迁移追加的 5 个列定义清单 */
export const V6_COLUMNS = [
  { name: 'tool_calls_json', definition: 'TEXT DEFAULT NULL' },
  { name: 'tool_results_json', definition: 'TEXT DEFAULT NULL' },
  { name: 'citations_json', definition: 'TEXT DEFAULT NULL' },
  { name: 'search_state_json', definition: 'TEXT DEFAULT NULL' },
  { name: 'server_diagnostics_json', definition: 'TEXT DEFAULT NULL' },
] as const;

export type V6ColumnName = (typeof V6_COLUMNS)[number]['name'];

/**
 * v6 迁移 DDL SQL 语句列表（供 MIGRATIONS 数组顺序执行）
 */
export const V6_MESSAGE_TOOLS_AND_SEARCH_SQL: readonly string[] =
  V6_COLUMNS.map(
    (col) =>
      `ALTER TABLE local_messages ADD COLUMN ${col.name} ${col.definition}`
  );

/**
 * 检查指定表是否存在某列（兼容 MemorySqlDriver 与真实 SQLite 环境）
 */
export async function hasColumn(
  db: SqlDriver,
  tableName: string,
  columnName: string
): Promise<boolean> {
  // 1. MemorySqlDriver: 读取私有 tables 结构（快速直接判定）
  const memDriver = db as unknown as {
    tables?: Map<string, { cols: string[] }>;
  };
  if (memDriver.tables && typeof memDriver.tables.get === 'function') {
    const table = memDriver.tables.get(tableName);
    return table ? table.cols.includes(columnName) : false;
  }

  // 2. 真实 SQLite / expo-sqlite 环境：使用 PRAGMA table_info 查询
  try {
    const rows = await db.getAll<{ name: string }>(
      `PRAGMA table_info(${tableName})`
    );
    if (Array.isArray(rows) && rows.length > 0) {
      return rows.some((row) => row.name === columnName);
    }
  } catch {
    // 驱动不支持 PRAGMA table_info 时降级到 SELECT 探测
  }

  // 3. 兜底方案：尝试 SELECT 该列 LIMIT 0
  try {
    await db.exec(`SELECT ${columnName} FROM ${tableName} LIMIT 0`);
    return true;
  } catch {
    return false;
  }
}

/**
 * 幂等执行 v6 迁移：
 * 逐列检查是否存在，仅在列不存在时执行 ALTER TABLE ADD COLUMN。
 * 兼容多次重复调用，不会因重复追加列而抛错。
 */
export async function migrateV6WebSearchAndTools(db: SqlDriver): Promise<void> {
  for (const col of V6_COLUMNS) {
    const exists = await hasColumn(db, 'local_messages', col.name);
    if (!exists) {
      try {
        await db.exec(
          `ALTER TABLE local_messages ADD COLUMN ${col.name} ${col.definition}`
        );
      } catch (err) {
        const msg = String(err);
        if (!msg.includes('已存在') && !msg.includes('duplicate column')) {
          throw err;
        }
      }
    }
  }
}

/** 迁移对象定义（符合 M5 §5.4 规范） */
export const v6Migration = {
  name: 'v6-message-tools-and-search',
  sql: V6_MESSAGE_TOOLS_AND_SEARCH_SQL,
  migrate: migrateV6WebSearchAndTools,
} as const;
