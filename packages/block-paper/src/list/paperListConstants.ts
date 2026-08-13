/**
 * W3-G · PaperList data-* 契约（SD-20 切开 · constants）
 *
 * 结构门 / e2e 可锚定。公开入口仍为 `PaperList.ts` re-export。
 *
 * - **≠ EL-01**；**≠ W3-P** WindowManager；**≠ C2 默开**
 * - 本模块只钉属性名，不持 DOM、不改产品默装
 */

/** 列表根 */
export const BP_PAPER_LIST = 'data-bp-paper-list';
/** 单块行（仅 mountIds） */
export const BP_PAPER_BLOCK = 'data-bp-paper-block';
/** block id */
export const BP_PAPER_BLOCK_ID = 'data-block-id';
/** 顶部 spacer */
export const BP_PAPER_SPACER_BEFORE = 'data-bp-spacer-before';
/** 底部 spacer */
export const BP_PAPER_SPACER_AFTER = 'data-bp-spacer-after';
/** 挂载块数（结构门可读） */
export const BP_PAPER_MOUNTED_COUNT = 'data-mounted-count';
/** 投影总块数（≠ DOM 数） */
export const BP_PAPER_TOTAL_COUNT = 'data-total-count';
/** 结构门：mounted ≤ MAX 时为 "1" */
export const BP_PAPER_WITHIN_DOM_BOUND = 'data-within-dom-bound';
/** 块宿主（仅窗口∪pin 行） */
export const BP_PAPER_BLOCK_HOST = 'data-bp-block-host';
/** 标题级 1–6（LR-V4；与 React `.blockRow[data-heading-level]` 同选择器名） */
export const BP_PAPER_HEADING_LEVEL = 'data-heading-level';
/** 焦点行皮（LR-V4；吃 inset，不吃 `--focus-ring` 30%） */
export const BP_PAPER_FOCUS = 'data-bp-focus';

/**
 * 未给 window/scroll 时的默认可见块数（结构门测友好）。
 * 仍受 overscan + MAX_MOUNTED_DOM_BLOCKS 约束。
 */
export const PAPER_LIST_DEFAULT_VISIBLE_COUNT = 20;
