/**
 * W3-D-PM · 真 ProseMirror 文本叶适配器
 *
 * - `leafInlineSchema`：仅 inline 单 paragraph schema
 * - `PmTextLeaf`：活动叶 EditorState + dispatchTransaction → TextEditIntent
 * - `PmTextLeafHost`：EditorView 挂载 + composition 边界
 *
 * ## 轨声明（强制）
 * - **W3-D-PM 完成** = 真 PM 适配器入库；Intent 可仍走 **mock sink**
 * - **≠ W3-D**（真 `DocSession::apply` 终局）
 * - **≠ EL-01** / **≠ A-BLK 全表**
 * - plain `TextLeafModel` 保留（W3-D-S）
 * - **禁止** serialize(pmDoc) 持久化
 */

export {
  leafInlineSchema,
  pmLeafSchema,
  textToLeafDoc,
  leafDocToText,
  textOffsetToPmPos,
  pmPosToTextOffset,
} from './schema';

export {
  PmTextLeaf,
  diffToReplace,
  isPmTextLeaf,
  type PmTextLeafSnapshot,
  type PmTextLeafOptions,
} from './PmTextLeaf';
export {
  PmTextLeafHost,
  createPmLeafEditorState,
  isPmTextLeafHost,
  type PmTextLeafHostOptions,
} from './PmTextLeafHost';
