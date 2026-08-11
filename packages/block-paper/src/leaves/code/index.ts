/**
 * W3-E · CM6 代码叶骨架
 *
 * - CodeLeafModel：language / readOnly / focused / content + text_edit Intent
 * - CodeLeafHost / mock / mountCodeLeaf：可聚焦 host；真实 CM6 挂点已标注
 *
 * **W3-E ≠ 全语言高亮完成**；**≠** 接真实 RS。
 */

export {
  CodeLeafModel,
  type CodeLanguage,
  type CodeLeafSnapshot,
  type CodeLeafModelOptions,
  type CodeEditRejectCode,
  type CodeEditAttempt,
} from './CodeLeafModel';

export {
  createMockCodeLeafHost,
  DomCodeLeafHost,
  mountCodeLeaf,
  type CodeLeafHost,
  type MockCodeLeafHost,
  type MockCodeLeafHostOptions,
  type MountCodeLeafOptions,
  type CodeLeafMount,
} from './CodeLeafHost';
