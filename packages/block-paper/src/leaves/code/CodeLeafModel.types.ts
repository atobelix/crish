/**
 * 代码叶模型公开类型与纯 helpers（SD-54 再抽）。
 *
 * 从 `CodeLeafModel.ts` 切开：`CodeLanguage` / 快照 / Options / 编辑结果
 * 以及 `clampOffset` / `resolveFlag` / `buildCodeTextEditIntent`。
 * IME / 只读逻辑仍在 `CodeLeafModel` class。
 *
 * `CodeLeafModel.ts` 再 export 本模块类型，既有
 * `from './CodeLeafModel'` / `from './index'` 公开面不断。
 *
 * ## 诚实边界
 * - **SD-54 再抽**；**≠** EL-01；**≠** A-BLK-14 产品 focus e2e
 * - **≠** 占 W3-E 首批；**≠** 改 flavour / fence 映射
 */

import type {
  BlockId,
  IntentId,
  TextEditIntent,
} from '@crish/block-paper-contract';
import type { CodeLeafHost } from './CodeLeafHost';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 语言 id：与 fence info / CM6 LanguageSupport 对齐的轻量字符串 */
export type CodeLanguage = string;

/** 代码叶只读快照 */
export type CodeLeafSnapshot = {
  blockId: BlockId;
  /** 全文 content（plain；CM6 doc 投影） */
  content: string;
  language: CodeLanguage;
  readOnly: boolean;
  focused: boolean;
  composing: boolean;
  /** 合成锚点 offset；非 composing 时 null */
  compositionAnchor: number | null;
  /** 合成开始时被替换区间 end（半开）；非 composing 时 null */
  compositionReplaceEnd: number | null;
};

export type CodeLeafModelOptions = {
  /** 初始语言；默认 `plaintext` */
  language?: CodeLanguage;
  /** 只读；默认 false */
  readOnly?: boolean;
  /**
   * 自定义 intentId 工厂；缺省用共享 `nextIntentId`。
   */
  createIntentId?: () => IntentId;
  /**
   * 可选 IME composing 查询（boolean 或回调）。
   * - 若注入且当前 composing：`applyLocalEdit` 仅改本地缓冲，返回 null
   * - 亦可走本模型 `beginComposition` 本地合成态（与 TextLeaf 同构）
   * 与 editor-kit `ImeMachine.isComposing` 对接时注入即可。
   */
  isComposing?: boolean | (() => boolean);
  /**
   * 可选 host（CM6 / mock）。构造后也可 `attachHost`。
   */
  host?: CodeLeafHost;
};

/** 编辑拒绝原因 */
export type CodeEditRejectCode = 'read_only' | 'not_focused' | 'invalid_range';

/**
 * 带拒绝码的编辑结果（只读 / 失焦显式失败；composing 仍返回 null Intent 以对齐 TextLeaf）。
 */
export type CodeEditAttempt =
  | { ok: true; intent: TextEditIntent | null; content: string }
  | { ok: false; code: CodeEditRejectCode; reason: string };

// ---------------------------------------------------------------------------
// 工具（无 IME / 只读策略；策略仍在 class）
// ---------------------------------------------------------------------------

export function clampOffset(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function resolveFlag(v: boolean | (() => boolean) | undefined): boolean {
  if (v === undefined) return false;
  if (typeof v === 'function') return Boolean(v());
  return Boolean(v);
}

/** 装配一条 `text_edit`（不改缓冲、不判只读） */
export function buildCodeTextEditIntent(
  blockId: BlockId,
  start: number,
  end: number,
  insert: string,
  intentId: IntentId
): TextEditIntent {
  return {
    type: 'text_edit',
    blockId,
    range: [start, end],
    insert,
    intentId,
  };
}
