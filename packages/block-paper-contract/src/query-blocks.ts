/**
 * `query_blocks` 工具入参 / 出参类型草稿。
 *
 * 对齐：`docs/block-workspace-architecture/plans/specs/query-blocks-tool-schema.md`
 *
 * 约定：
 * - 字段名保持 **snake_case**（工具 JSON 线格式，与 schema 一致）
 * - 禁止任意 SQL 字符串；全表扫不得作为默认路径
 * - 本文件仅类型契约；store 实现见 `crates/conex-workspace-store/src/query_blocks.rs`
 * - agent-tools 执行器接线留 W4-A
 */

/** 属性等值过滤值：JSON 可序列化子集 */
export type QueryBlocksAttrValue = string | number | boolean | null;

/**
 * `query_blocks` 入参。
 *
 * - `doc_id` 必填
 * - `limit` 默认 50，上限 200（实现层强制；类型层不绑 default 运行时）
 */
export type QueryBlocksParams = {
  /** 目标文档 */
  doc_id: string;
  /** 块 kind / flavour 白名单过滤 */
  kind_in?: string[];
  /**
   * 属性等值组合（白名单键）。
   * 实现须拒绝未知/非白名单键，不得当作任意 JSONPath。
   */
  attrs_eq?: Record<string, QueryBlocksAttrValue>;
  /** FTS 子串 / 短语 */
  text_match?: string;
  /** 引用目标 block_id（谁引用了该块） */
  ref_to?: string;
  /** 引用源 block_id（该块引用了谁） */
  ref_from?: string;
  /**
   * 结果上限。
   * @maximum 200
   * @default 50
   */
  limit?: number;
};

/** 单条命中块摘要（禁止默认回传全文） */
export type QueryBlocksHit = {
  id: string;
  kind: string;
  /** 检索摘要片段，非权威全文 */
  snippet: string;
  /** 已校验 / 索引侧属性子集 */
  attrs: Record<string, QueryBlocksAttrValue>;
};

/**
 * `query_blocks` 出参。
 *
 * `{ "blocks": [...], "truncated": false }`
 */
export type QueryBlocksResult = {
  blocks: QueryBlocksHit[];
  /** 是否因 limit 截断 */
  truncated: boolean;
};

/** 工具名常量（与 schema 文档一致） */
export const QUERY_BLOCKS_TOOL_NAME = 'query_blocks' as const;

/** limit 硬上限（实现与验收共用） */
export const QUERY_BLOCKS_LIMIT_MAX = 200 as const;

/** limit 默认值 */
export const QUERY_BLOCKS_LIMIT_DEFAULT = 50 as const;
