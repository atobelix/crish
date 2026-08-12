// DAO 公共类型（Z0 R2-13：8 表 CRUD 纯接口 + 注入 driver 实现）
// 设计：每个 DAO 定义「行类型 + 纯接口 + SqlXxxDao 实现（构造注入 SqlDriver）」；
// 真实环境注入 expo-sqlite 适配器（db.ts），测试注入 MemorySqlDriver。
import type { SqlDriver } from '../driver';

/** DAO 构造注入的驱动（统一依赖形态） */
export interface DaoDeps {
  driver: SqlDriver;
}

/** 通用 upsert 结果（调用方如需感知新增/覆盖） */
export type UpsertResult = 'inserted' | 'updated';
