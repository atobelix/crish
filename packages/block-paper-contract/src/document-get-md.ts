/**
 * `document_get_md` 工具入参 / 出参类型草稿。
 *
 * 对齐：`docs/block-workspace-architecture/plans/03-MD契约.md`
 * - Agent 读 = **即时 S(树)**，禁止默认读陈旧 exports / mirror
 * - RS 真源：`conex_md_ast::document_to_md` / `serialize_tree`
 *
 * 约定：
 * - 字段名 **snake_case**（工具 JSON 线格式）
 * - 本文件仅类型契约；执行器接线留后续波次
 */

/** `document_get_md` 入参 */
export type DocumentGetMdParams = {
  /** 目标文档 */
  doc_id: string;
};

/**
 * `document_get_md` 出参。
 *
 * `md` = 当前权威块树的即时 Conex-MD 序列化（含 `<!--c:UUID-->`）。
 */
export type DocumentGetMdResult = {
  /** Conex-MD 全文 = 即时 S(树)，非陈旧 mirror/export */
  md: string;
};

/** 工具名常量（与 Agent 工具面一致） */
export const DOCUMENT_GET_MD_TOOL_NAME = 'document_get_md' as const;
