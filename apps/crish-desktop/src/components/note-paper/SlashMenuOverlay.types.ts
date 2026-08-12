/**
 * SlashMenuOverlay 公共类型（SD-13 外置）
 *
 * **≠ EL-01**；**≠ A-BLK-02 产品 e2e**。类型切开 ≠ slash 交互完成。
 */

import type React from 'react';
import type {
  IntentSink,
  SlashInsertIntent,
  SlashMenuModel,
  SlashSelectAndSubmitResult,
  SubmitIntentOptions,
} from '@crish/block-paper';

/**
 * slash 写模式（CONN-B）。
 * - `writable`：允许选中并（有 sink 时）submit
 * - `readonly`：catalog 可见但 **禁提交**；点击/Enter no-op（防假写）
 * - 未传：兼容库测——有 sink 则 submit，无 sink 则 intent-only
 */
export type SlashOverlayWriteMode = 'writable' | 'readonly';

export type SlashMenuOverlayProps = {
  /** 状态源；open/filter/active 全由 model 持有 */
  menu: SlashMenuModel;
  /**
   * Intent 接收端。提供时点击/Enter 自动 `select*AndSubmit`。
   * 未提供且非 readonly 时仅回调 `onSelectIntent`（调用方自行 sink）。
   */
  sink?: IntentSink;
  /**
   * 写模式。产品 Strict 空态无 apply 时须传 `readonly`（CONN-B）。
   * 未传时保持库测兼容（无 sink 仍可 intent-only）。
   */
  writeMode?: SlashOverlayWriteMode;
  /** 透传 submitIntent 的 IME 选项 */
  submitOptions?: SubmitIntentOptions;
  /**
   * model 变更后强制重绘（open / setQuery / moveActive 后由父级 bump）。
   * model 本身非 React 状态，须此 token 或本地 forceTick。
   */
  syncToken?: number | string;
  /**
   * 锚点样式（绝对定位于阅读列内；缺省由 CSS 顶部偏移）。
   * Portal 后置；本波 absolute 浮层即可测。
   */
  style?: React.CSSProperties;
  className?: string;
  /** 浮层 data-testid；默认 note-paper-slash-overlay */
  testId?: string;
  /** 选中产出 Intent 后（无论是否已 submit） */
  onSelectIntent?: (intent: SlashInsertIntent) => void;
  /** 完整 select+submit 结果 */
  onSubmitResult?: (result: SlashSelectAndSubmitResult) => void;
  /** 菜单关闭后（选中成功 / Escape） */
  onClose?: () => void;
  /** 空过滤文案 */
  emptyMessage?: string;
  /** 只读态提示文案（writeMode=readonly 时可选展示） */
  readOnlyMessage?: string;
};
