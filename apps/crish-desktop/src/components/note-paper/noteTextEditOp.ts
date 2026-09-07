/**
 * 笔记块文本差量 text_edit op 计算（audit-repair-202609 · T8）
 *
 * 语义：以「最后一次确认落盘的块文本」为基准，计算 common prefix / suffix
 * 后产出**单条最小替换** collab wire op——替代历史「每次击键整块删除再整块
 * 插入」的伪差量路径（破坏引擎 undo / 协作语义且每键 O(n)）。
 *
 * 偏移量与插入内容均按 Unicode 标量（code point）计，对齐引擎
 * `conex-doc-collab/src/op.rs` TextEdit 的 `chars().count()` 约定；
 * 引擎内 `char_range_to_bytes` 负责转 yrs 字节偏移。
 *
 * 本模块为纯函数，零 React / IPC 依赖，可独立穷举单测。
 */

/** collab wire text_edit op（与 `@crish/block-paper-contract` CollabTextEditOpWire 同形） */
export interface NoteTextEditOp {
  op: 'text_edit';
  id: string;
  /** 起始 Unicode 标量偏移（含） */
  start: number;
  /** 结束 Unicode 标量偏移（不含） */
  end: number;
  /** 替换插入的文本 */
  insert: string;
}

/**
 * 计算 `oldText → newText` 的最小 text_edit op。
 *
 * - `oldText === newText` → `null`（无变化，不发起 apply）
 * - 其余情况恒返回一条 op：`[start, end)` 为 oldText 中被替换区间，
 *   `insert` 为 newText 对应替换内容（可为空串 = 纯删除）。
 */
export function computeTextEditOp(
  blockId: string,
  oldText: string,
  newText: string
): NoteTextEditOp | null {
  if (oldText === newText) {
    return null;
  }

  const oldPoints = Array.from(oldText);
  const newPoints = Array.from(newText);
  const oldLen = oldPoints.length;
  const newLen = newPoints.length;
  const minLen = Math.min(oldLen, newLen);

  let prefix = 0;
  while (prefix < minLen && oldPoints[prefix] === newPoints[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldPoints[oldLen - 1 - suffix] === newPoints[newLen - 1 - suffix]
  ) {
    suffix++;
  }

  return {
    op: 'text_edit',
    id: blockId,
    start: prefix,
    end: oldLen - suffix,
    insert: newPoints.slice(prefix, newLen - suffix).join(''),
  };
}
