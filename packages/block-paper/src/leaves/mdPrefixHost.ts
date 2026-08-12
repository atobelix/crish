/**
 * MD 前缀产品输入接线（W3-H · 可测路径 · SD-46 再抽）。
 *
 * 把库内纯函数 `tryMdPrefixFastPath` / `submitTurnIntoIntent` 接到叶输入的
 * 「行首 MD 前缀 + 提交」路径——模拟 / 宿主在键入 `# ` / `- ` 后调用本模块。
 *
 * 实现已拆：
 * - `mdPrefixHost.commit`：叶快照类型 + `commitMdPrefixFromLeaf` / `tryMdPrefixAfterLeafEdit`
 * - `mdPrefixHost.simulate`：`simulateMdPrefixSubmit`
 * - `mdPrefixHost.audit`：mock / provisional collab / 双通道审计 sink
 *
 * 本文件保持既有 `from './mdPrefixHost'` 路径（barrel re-export）。
 *
 * ## 与 slash 通道关系
 * - **独立通道**：本 host 只走 `TurnIntoSink`，**不**改 `structureIntents` /
 *   `SlashMenuModel` / `SlashMenuOverlay` / `submitIntent` 闭包
 * - slash_insert 仍走 `IntentSink`；二者可同会话审计并列，**不互抹**
 *
 * ## 诚实边界
 * - CONN-D：RS 已消费 `pending_turn_into_flavour` / 真 `Op::TurnInto`（apply 后 kind 可变）
 * - `createTurnIntoProvisionalCollabSink` 下发 strip `text_edit` + pending 标记；
 *   经真实 `applyOps`→RS 后 kind 可变；**桌面 PM/HiddenInput 键入全链仍可能未接**
 * - **≠ EL-01**；**≠ A-BLK-08/09 全表 e2e**；**≠** 假关 W3-H Strict 产品 e2e
 * - UI **禁止**单读 `pending_turn_into_flavour` 当块 kind（权威是投影 kind）
 * - provisional ≠ kind；**禁止**第二写锥
 *
 * ## 轨
 * - 文件域：`leaves/mdPrefixHost.ts` + 兄弟模（避 slash 大文件对撞）
 * - 可注入 sink：mock 形状测 或 provisional collab adapter
 */

// 叶提交核
export {
  commitMdPrefixFromLeaf,
  tryMdPrefixAfterLeafEdit,
  type MdPrefixLeafSnapshot,
  type MdPrefixCommitOptions,
  type MdPrefixCommitOk,
  type MdPrefixCommitFail,
  type MdPrefixCommitResult,
} from './mdPrefixHost.commit';

// 模拟「行首输入 MD 前缀 + 提交」
export {
  simulateMdPrefixSubmit,
  type SimulateMdPrefixSubmitInput,
  type SimulateMdPrefixSubmitResult,
} from './mdPrefixHost.simulate';

// mock / provisional / 双通道审计
export {
  createMockTurnIntoSink,
  createTurnIntoProvisionalCollabSink,
  createProductIntentAuditSinks,
  type MockTurnIntoSink,
  type TurnIntoProvisionalCollabSink,
  type ProductIntentAuditEntry,
  type ProductIntentAuditSinks,
} from './mdPrefixHost.audit';
