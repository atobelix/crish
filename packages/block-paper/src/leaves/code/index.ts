/**
 * W3-E · CM6 代码叶（方向子集）
 *
 * - CodeLeafModel：language / readOnly / focused / content + text_edit Intent
 * - CodeLeafHost / mock / DomCodeLeafHost / mountCodeLeaf
 * - Cm6CodeLeafHost：真 @codemirror/view EditorView 接线（plain + javascript）
 * - codeFlavourMap：flavour `code` / fence ↔ collab kind `'code'` 诚实映射
 * - ReadonlyCodePresentation：非活动叶只读 DOM 呈现（≠ CM6 可编辑 e2e）
 *
 * ## 诚实边界（强制）
 * - **≠** 产品 e2e 满关；**≠** EL-01；**≠** A-BLK-14 产品 focus e2e
 * - **≠** 全语言高亮完成；**≠** 接真实 RS 为生产终局关闭项
 * - 只读呈现适配 **≠** 活动叶 CM6 编辑（dual-engine E4）
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

export {
  CODE_FLAVOUR_IDS,
  CODE_COLLAB_KIND,
  isCodeFlavour,
  codeFlavourToCollabKind,
  isCodeCollabKind,
  parseFenceInfo,
  fenceOpenToLanguage,
  resolveCodeLeafLanguage,
  codeLeafAttrsForLanguage,
  resolveCodeLeafKindAndLanguage,
  type CodeFlavourId,
  type CodeCollabKind,
  type ResolveCodeLeafLanguageInput,
  type CodeLeafKindResolution,
} from './codeFlavourMap';

export {
  mountReadonlyCodePresentation,
  createReadonlyCodeSnapshot,
  createReadonlyCodeLeafModel,
  BP_CODE_READONLY,
  BP_CODE_READONLY_CODE,
  type ReadonlyCodePresentationSnapshot,
  type MountReadonlyCodePresentationOptions,
  type ReadonlyCodePresentationMount,
} from './ReadonlyCodePresentation';
