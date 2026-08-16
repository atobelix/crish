/**
 * 结构 Intent 公开入口（SD-08 · structureIntents 三切 · barrel re-export）
 *
 * 实现已拆：
 * - `structureIntentTypes`：类型 + 守卫
 * - `structureIntentBuilders`：工厂 builders
 * - `structureIntentToWire`：collab Op wire / JSON 半桥
 *
 * 本文件保持既有 import 路径与包级 API（`index.ts` 仍从本模块 re-export）。
 *
 * 与 `TextLeafModel` 产出的 `text_edit`（文本 Intent）区分：
 * - 文本 Intent：叶子局部替换（W0 `TextEditIntent`）
 * - 结构 Intent：插入 / 删除 / 移动 / 折叠 / slash 选中项
 *
 * 联合：`PaperIntent = TextIntent | StructureIntent | OpIntent(W0)`
 * （`OpIntent` 仍可直接下发 sink，结构 Intent 亦可经 `structureIntentToOp` 映射）。
 *
 * ## 写路径纪律（强制 · W3-D Strict / G-INV-3）
 *
 * - **UI StructureIntent 不得直接写盘 / 旁路 mutate 树**
 * - 必须：`StructureIntent` → `structureIntentToOps` / `paperIntentToOps` /
 *   `submitStructureToCollabWire`（collab wire JSON）
 *   → **`createCollabApplySink`（生产默认）** / IPC → RS `ops_from_json` → `DocSession::apply`
 * - wire 形状对齐 `conex-doc-collab::Op`（snake_case、tag=`op`）
 * - `createMockIntentSink` **仅**形状测；真 apply 库侧见
 *   `w3_d_structure_intent_or_wire_applys_to_session` / `w3_d_strict_text_and_structure_intent_true_apply`
 *
 * ## 轨声明（诚实 · 09 §0.4）
 *
 * - 本模块提供 wire 半桥；**生产 sink** 用 `createCollabApplySink`
 * - 真 PM 叶见 `leaves/pm`（W3-D-PM）；与本 wire + RS 真 apply 合 = **W3-D**
 * - **W3-F Strict 子集**：chrome `slash_insert` / `delete_blocks` → `submitIntent` →
 *   `createCollabApplySink` → wire → RS apply（测：`chrome.apply.test.ts` + `w3_f_*`）
 * - **W3-F-S**：StructureIntent + wire + mock（`chrome.shape.test.ts`）；**不得**关 Strict
 * - **≠ EL-01**；**≠ A-BLK 全表**；禁止 mock sink 冒充 Strict 关闭
 * - **W3-F DOM 余量**：`BlockChromeDomHost` 把手/多选框/落点线/slash 宿主/拖拽预览子集
 *   jsdom 契约（`chrome.dom.test.ts` · `chrome.drag.test.ts`）；**DOM ≠ EL-01**
 * - **桌面 React chrome 挂载已交**（`BlockChromeDomMount` / Strict 槽）；**仍未交付**的精确项：
 *   A-BLK 全表 e2e、真 Pointer 拖拽产品 e2e、桌面产品级 chrome 交互 e2e
 *
 * ## 分层边界（gray zone · CT-04 固化 · 2026-08-13）
 *
 * - 本模块为**中立 intent 契约**（类型 + wire 半桥），不隶属 chrome / leaves 任一侧；
 * - `leaves/` 层的类型/wire 消费（`intentBridge` 下行）为本仓库**受权边界**；
 * - `chrome/` 内新 UI 不得反向依赖 `leaves/` 内部实现，仅可经 `intentBridge`
 *   提交协议下行（既有生产面：`slashSelectAndSubmit.ts` 仅消费 intentBridge 协议）；
 * - 禁止迁移本模块到 contract 包或新建共享目录（反过度设计红线）。
 */

// 类型 + 守卫
export {
  isStructureIntent,
  isPaperIntent,
  type StructureIntentOrigin,
  type StructureIntentType,
  type InsertBlockIntent,
  type DeleteBlocksIntent,
  type MoveBlocksIntent,
  type ToggleCollapseIntent,
  type SlashInsertIntent,
  type StructureIntent,
  type TextIntent,
  type PaperIntent,
} from './structureIntentTypes';

// 工厂 builders
export {
  buildInsertBlockIntent,
  buildDeleteBlocksIntent,
  buildMoveBlocksIntent,
  buildToggleCollapseIntent,
  buildSlashInsertIntent,
  type BuildIntentIdFn,
  type BuildInsertBlockInput,
  type BuildDeleteBlocksInput,
  type BuildMoveBlocksInput,
  type BuildToggleCollapseInput,
  type BuildSlashInsertInput,
} from './structureIntentBuilders';

// collab wire 半桥
export {
  structureIntentToOps,
  structureIntentToOp,
  paperIntentToOps,
  submitStructureToCollabWire,
  type StructureToOpsOptions,
  type StructureCollabWirePayload,
} from './structureIntentToWire';
