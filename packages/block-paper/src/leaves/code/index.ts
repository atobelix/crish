/**
 * W3-E · CM6 代码叶
 *
 * - CodeLeafModel：language / readOnly / focused / content + text_edit Intent
 * - CodeLeafHost / mock / DomCodeLeafHost / mountCodeLeaf
 * - Cm6CodeLeafHost：真 @codemirror/view EditorView 接线（plain + javascript）
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

export {
  Cm6CodeLeafHost,
  createCm6EditorState,
  resolveCm6LanguageExtension,
  isCm6HighlightedLanguage,
  isCm6CodeLeafHost,
  type Cm6CodeLeafHostOptions,
  type CreateCm6EditorStateOptions,
  type Cm6EditorStateBundle,
} from './Cm6CodeLeafHost';
