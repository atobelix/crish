/**
 * 产品 Strict MD 前缀叶输入接线（CONN-D2/D3 · 桌面 mdPrefix 写锥 · SD-22）
 *
 * 实现已拆：
 * - `noteMdPrefixBridge.types`：写模式 / 绑定 / 提交结果类型
 * - `noteMdPrefixBridge.binding`：工厂 + Strict props 拼装 + UI 写模式解析
 * - `noteMdPrefixBridge.commit`：叶提交 / tryAfterEdit / plainText
 * - `noteMdPrefixBridge.simulate`：CONN-D3 模拟「行首前缀 + 提交」
 *
 * 本文件保持既有 import 路径（index / 叶宿主 / G2 测仍从本模块 re-export）。
 *
 * ## 角色
 * - 把库侧 `commitMdPrefixFromLeaf` / `createTurnIntoProvisionalCollabSink`
 *   接到 note-paper / 空态产品路径（与 CONN-B slash 写锥并列、**独立通道**）。
 * - 有 `applyOps` / 注入 `TurnIntoSink` → 可写；无后端 → **disabled**（不假装转块）。
 * - 文本叶 / Strict content-row HiddenInput 在「行首 MD 前缀 + 提交」后调用
 *   `commitProductMdPrefixFromLeaf`（或 `tryProductMdPrefixAfterLeafEdit` /
 *   `simulateProductMdPrefixSubmit`）。
 *
 * ## CONN-D3
 * - Strict content-row 叶宿主（`StrictContentRowLeaf`）→ 本桥产品路径
 * - `simulateProductMdPrefixSubmit`：行首 `# `/`- ` + 提交可测（无 DOM 亦可）
 * - **≠** A-BLK-08/09 全 e2e；**≠ EL-01**；UI **禁止**读 pending 当 kind
 *
 * ## 诚实边界（钉死）
 * - **桌面接线 ≠ 打开完成**；**≠ A-BLK-08/09 全表 e2e**；**≠ EL-01**
 * - provisional wire = strip `text_edit` + `pending_turn_into_flavour`；
 *   真 kind 权威在 RS apply（CONN-D）；mock applyOps **不**证权威
 * - UI **禁止**单读 `pending_turn_into_flavour` 当块 kind（权威是投影 kind）
 * - composing 双守卫（fast_path + submit）**不回退**
 * - **禁止**用本桥 / 库 `mdPrefixHost` 单测关 A-BLK-08/09 / EL-01
 * - **CONN-G2**：product-ipc applyOps 写成功（applied>0）经 adapt 发
 *   `notifyNoteDocWritten(source: product_apply)`；失败/未 applied 不通知；**≠ 打开完成**
 *
 * ## 与 slash 关系
 * - 本文件只走 `TurnIntoSink`；slash 仍走 `IntentSink`（productSlashSink）
 * - 同 `strictApplyOps` 可同时驱动两通道；**不互抹**
 *
 * 目标：主文件 **<400**（装配壳宜 <350）；切开 ≠ 关 EL。
 *
 * surface = note-paper；文件域独立，避 SD-04-R StrictPanel 大重构对撞。
 */

// 类型
export type {
  CommitProductMdPrefixOptions,
  CreateProductMdPrefixBindingOptions,
  ProductMdPrefixBinding,
  ProductMdPrefixCommitResult,
  ProductMdPrefixSinkSource,
  ProductMdPrefixWriteMode,
  ResolveStrictMdPrefixBindingInput,
  SimulateProductMdPrefixSubmitInput,
  SimulateProductMdPrefixSubmitResult,
  StrictMdPrefixUiBinding,
} from './noteMdPrefixBridge.types';

// 工厂 / Strict 拼装 / UI 写模式
export {
  bindingFromStrictMdPrefixProps,
  createProductMdPrefixBinding,
  resolveStrictMdPrefixBinding,
} from './noteMdPrefixBridge.binding';

// 叶提交 / tryAfterEdit / plainText
export {
  commitProductMdPrefixFromLeaf,
  commitProductMdPrefixFromPlainText,
  tryProductMdPrefixAfterLeafEdit,
} from './noteMdPrefixBridge.commit';

// CONN-D3 模拟提交
export { simulateProductMdPrefixSubmit } from './noteMdPrefixBridge.simulate';
