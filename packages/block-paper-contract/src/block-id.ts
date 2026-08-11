/**
 * 块标识与文档标识（W0 接口冻结 §2 / §4）。
 *
 * 权威定义最终归属 conex-doc-collab；本包仅提供 TS 侧契约别名，
 * 避免实现波各自发明 `string` 语义漂移。
 */

/** 稳定块 ID（跨投影 / 索引 / 工具面共用） */
export type BlockId = string;

/** 文档 ID */
export type DocId = string;

/** 文档单调版本（ProjectionDiff.rev） */
export type DocRev = number;

/** 意图 ID（乐观缓冲 / reject 关联） */
export type IntentId = string;

/** 块 flavour / kind 标识（与 query_blocks.kind、投影 flavour 对齐） */
export type FlavourId = string;
