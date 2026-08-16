/**
 * @crish/block-paper-contract
 *
 * 块纸面 W0 接口冻结的 TypeScript 类型草稿包。
 * **仅契约，不接线业务**（不改 apps、不实现工具/注册表/投影）。
 *
 * 来源文档：
 * - `plans/specs/query-blocks-tool-schema.md`
 * - `plans/specs/register-flavour-roadmap.md`
 * - `plans/interfaces/00-W0接口冻结.md`
 * - `plans/specs/dual-engine-surface.md`（EditorSurface / SendToNote / A-SURF）
 */

// 标识
export type { BlockId, DocId, DocRev, IntentId, FlavourId } from './block-id';

// query_blocks
export type {
  QueryBlocksAttrValue,
  QueryBlocksParams,
  QueryBlocksHit,
  QueryBlocksResult,
} from './query-blocks';
export {
  QUERY_BLOCKS_TOOL_NAME,
  QUERY_BLOCKS_LIMIT_MAX,
  QUERY_BLOCKS_LIMIT_DEFAULT,
} from './query-blocks';

// document_get_md（Agent 读 = 即时 S(树)；RS: document_to_md）
export type {
  DocumentGetMdParams,
  DocumentGetMdResult,
} from './document-get-md';
export { DOCUMENT_GET_MD_TOOL_NAME } from './document-get-md';

// FlavourRegistration
export type {
  FlavourSchema,
  SlashContribution,
  BlockViewContribution,
  FlavourRegistration,
  UnregisterFlavour,
  RegisterFlavour,
} from './flavour';
export { asFlavourRegistration } from './flavour';

// ProjectionDiff / MountSpec / Intent
export type {
  ProjectionUpsert,
  ProjectionDiff,
  DocEvent,
  ViewportWindow,
  HeightEntry,
  MountSpec,
  HeightMap,
  TextEditIntent,
  OpIntent,
  Intent,
} from './projection';

// EditorSurface / SendToNote（dual-engine-surface · A-SURF）
export type {
  EditorSurface,
  EditorSurfaceId,
  SendToNoteIntent,
  SendToNoteMode,
} from './surface';
export {
  EDITOR_SURFACES,
  SURFACE_CHAT,
  SURFACE_NOTE_PAPER,
  isSendToNoteIntent,
} from './surface';

// collab Op wire（conex-doc-collab snake_case JSON；Intent→apply 桥）
export type {
  CollabBlockKindWire,
  CollabBlockPropsWire,
  CollabInsertOpWire,
  CollabUpdatePropsOpWire,
  CollabMoveOpWire,
  CollabDeleteOpWire,
  CollabTextEditOpWire,
  CollabOpWire,
  CollabOpTag,
} from './opsWire';
export {
  flavourToCollabKind,
  emptyCollabProps,
  collabPropsWithAttrs,
  orderFromIndex,
  isCollabOpWire,
  assertCollabOpsWire,
  collabOpsFromJson,
  collabOpsToJson,
  requiredWireFields,
  assertWireFieldsPresent,
} from './opsWire';

// 坐标系（UTF-16 vs Unicode Scalar 标量品牌类型与双向单射转换）
export type { Utf16CodeUnitOffset, UnicodeScalarOffset } from './coordinates';
export {
  asUtf16Offset,
  asUnicodeScalarOffset,
  createUtf16Offset,
  createUnicodeOffset,
  isHighSurrogate,
  isLowSurrogate,
  isSurrogateCodePoint,
  isInsideSurrogatePair,
  alignToSurrogateBoundaryFloor,
  alignToSurrogateBoundaryCeil,
  utf16OffsetToUnicodeScalar,
  unicodeScalarToUtf16Offset,
  unicodeScalarLength,
  countUnicodeScalars,
  utf16Length,
  utf16RangeToUnicodeScalarRange,
  unicodeScalarRangeToUtf16Range,
} from './coordinates';

// 差分替换（Diff / Replace）
export type { DiffReplaceResult } from './diff';
export { diffToReplace } from './diff';
