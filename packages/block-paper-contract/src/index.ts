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

// registerFlavour
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
