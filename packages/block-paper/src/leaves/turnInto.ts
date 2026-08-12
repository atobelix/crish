/**
 * turn-into Intent 公开入口（SD-13-R · turnInto 切开 · barrel re-export）
 *
 * 实现已拆：
 * - `turnIntoTypes`：类型 + 守卫
 * - `turnIntoIntent`：工厂 / 选区钳制 / 提交 / provisional wire
 * - `turnIntoMdPrefix`：MD 前缀快路径
 *
 * 本文件保持既有 import 路径与包级 API（`index.ts` 仍从本模块 re-export）。
 *
 * 对齐：
 * - A-BLK-08：paragraph↔heading/list/quote… **保逻辑选区**（本波交付字段 + 钳制纯函数；≠ e2e）
 * - A-BLK-09：MD 前缀快路径；**composing 禁止**
 * - editor-kit `StructureKeyKind = 'turn_into'`
 * - `plans/05`：turn-into UI 在呈现层；Op 语义归 01（心侧）；本模块只产 Intent 形状
 *
 * ## 写锥纪律
 * - **禁止** DOM / PM serialize 旁路写盘
 * - 宿主：`TurnIntoIntent` → `submitTurnIntoIntent` → sink → wire → `DocSession::apply`
 * - CONN-D：RS 已消费 `attrs.pending_turn_into_flavour`（`UpdateProps` apply 后**改 kind**），
 *   且有真 `Op::TurnInto` 子集；本模块 provisional 仍发 strip `text_edit` + pending 标记
 *   （wire 可进 apply；**≠** 桌面 PM 键入全链；**不得**冒充 A-BLK-08 e2e，亦不得假关 EL-01）
 *
 * ## 轨
 * - **W3-H 方向子集**（本 barrel + 分模 + `mdPrefix.ts` + 单测）
 * - **≠** A-BLK 全表 e2e；**≠** EL-01；**≠** A-BLK-08/09 e2e 满关
 * - **≠** 与 slash 抢 `structureIntents.ts`；**≠** Slash Overlay 重做；**≠** PaperList
 * - 目标：主文件 **<400**（装配壳宜 <350）
 *
 * 优先新文件：不改 `chrome/structureIntents.ts`，避免与 slash 并行写撞车。
 */

// 类型 + 守卫
export {
  isTurnIntoIntent,
  type TurnIntoTrigger,
  type LogicalSelection,
  type TurnIntoIntent,
  type BuildTurnIntoInput,
  type MdPrefixFastPathRejectCode,
  type MdPrefixFastPathResult,
  type TryMdPrefixFastPathInput,
  type TurnIntoSink,
  type TurnIntoSinkResult,
  type SubmitTurnIntoOptions,
  type SubmitTurnIntoResult,
} from './turnIntoTypes';

// 工厂 / 钳制 / 提交 / provisional wire
export {
  buildTurnIntoIntent,
  clampLogicalSelection,
  submitTurnIntoIntent,
  turnIntoToStructureKey,
  turnIntoIntentToProvisionalOps,
  turnIntoStripToTextEdit,
} from './turnIntoIntent';

// MD 前缀快路径
export { tryMdPrefixFastPath } from './turnIntoMdPrefix';
