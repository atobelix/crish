/**
 * CM6 代码叶本地模型（W3-E 方向子集）。
 *
 * 对齐：
 * - W0 Intent：`text_edit`（blockId + range + insert + intentId）
 *   —— 代码叶变更走同一形状；sink / submitIntent 无需新类型即可下发
 * - 可聚焦：`focus()` / `blur()`；焦点态进 snapshot
 * - 只读：编辑拒绝，不产出 Intent、不改 content
 * - A-IME：可注入 `isComposing`；合成期缓冲，end 时 flush（与 TextLeafModel 同构）
 * - 写路径：Intent → submitIntent → sink →（未来）RS apply；**禁止** serialize(DOM)
 * - flavour / fence → collab kind：见 `codeFlavourMap`（kind=`code`；lang 进 attrs）
 *
 * **本模块不接真实后端**。Host 经 `CodeLeafHost` 注入；
 * 真 CM6 见 `Cm6CodeLeafHost` / `mountCodeLeaf({ createHost })`。
 *
 * ## 诚实边界
 * - **≠** 产品 e2e 满关；**≠** EL-01；**≠** A-BLK-14 产品 focus e2e
 * - **≠** 全语言高亮完成：language 字段 + Compartment 钩子就位；
 *   当前 CM6 lang 包仅 javascript，其余按需后接
 */

import type {
  BlockId,
  IntentId,
  TextEditIntent,
} from '@crish/block-paper-contract';
import { nextIntentId } from '../../intentId';
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
// 工具
// ---------------------------------------------------------------------------

function clampOffset(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function resolveFlag(v: boolean | (() => boolean) | undefined): boolean {
  if (v === undefined) return false;
  if (typeof v === 'function') return Boolean(v());
  return Boolean(v);
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * 单代码叶缓冲 + 焦点 + Intent 产出。
 *
 * 生命周期：
 * 1. 挂载 host（可选）→ `focus()` 进入可编辑
 * 2. 非 composing：`applyLocalEdit` / `tryApplyLocalEdit` → `text_edit`
 * 3. composing：本地缓冲；`flushOnCompositionEnd` 产出一条 `text_edit`
 * 4. `readOnly` 时一切编辑拒绝
 *
 * 与 TextLeaf 差异：
 * - 持有 `language` / `readOnly` / `focused`
 * - 默认可要求焦点才编辑（`requireFocus` 选项在 tryApply 层）；
 *   `applyLocalEdit` 为与 TextLeaf 对称的宽松路径（不强制焦点，只读仍拒）
 */
export class CodeLeafModel {
  readonly blockId: BlockId;
  private content: string;
  private language: CodeLanguage;
  private readOnly: boolean;
  private focused = false;
  private composing = false;
  private compositionAnchor: number | null = null;
  private compositionReplaceEnd: number | null = null;
  private preCompositionContent: string | null = null;
  private readonly createIntentId: () => IntentId;
  private readonly externalIsComposing: boolean | (() => boolean) | undefined;
  private host: CodeLeafHost | null = null;

  constructor(
    blockId: BlockId,
    initialContent = '',
    options: CodeLeafModelOptions = {}
  ) {
    if (!blockId) {
      throw new Error('CodeLeafModel：blockId 不可为空');
    }
    this.blockId = blockId;
    this.content = initialContent;
    this.language = options.language ?? 'plaintext';
    this.readOnly = options.readOnly ?? false;
    this.createIntentId =
      options.createIntentId ?? (() => nextIntentId('code'));
    this.externalIsComposing = options.isComposing;
    if (options.host) {
      this.attachHost(options.host);
    }
  }

  // -----------------------------------------------------------------------
  // 读
  // -----------------------------------------------------------------------

  getContent(): string {
    return this.content;
  }

  getLanguage(): CodeLanguage {
    return this.language;
  }

  isReadOnly(): boolean {
    return this.readOnly;
  }

  isFocused(): boolean {
    return this.focused;
  }

  isComposing(): boolean {
    return this.composing || resolveFlag(this.externalIsComposing);
  }

  getSnapshot(): CodeLeafSnapshot {
    return {
      blockId: this.blockId,
      content: this.content,
      language: this.language,
      readOnly: this.readOnly,
      focused: this.focused,
      composing: this.isComposing(),
      compositionAnchor: this.compositionAnchor,
      compositionReplaceEnd: this.compositionReplaceEnd,
    };
  }

  // -----------------------------------------------------------------------
  // 焦点
  // -----------------------------------------------------------------------

  /**
   * 聚焦代码叶。
   * - 更新本地 `focused`
   * - 若有 host：调用 `host.focus()`（真实 CM6：`EditorView.focus()`）
   */
  focus(): void {
    this.focused = true;
    this.host?.focus();
  }

  /**
   * 失焦。
   * - 若仍在本地 composing：不自动 flush（宿主应先 end composition）
   * - 调用 `host.blur()`
   */
  blur(): void {
    this.focused = false;
    this.host?.blur();
  }

  // -----------------------------------------------------------------------
  // 元数据
  // -----------------------------------------------------------------------

  /**
   * 设置语言 id。
   * 同步 host（真实 CM6 挂点：`Compartment.reconfigure(lang)`）。
   * **不**产出 Intent（语言属块 props，结构/属性 Op 由后续波接）。
   */
  setLanguage(language: CodeLanguage): void {
    this.language = language || 'plaintext';
    this.host?.setLanguage?.(this.language);
  }

  /**
   * 设置只读。同步 host。
   */
  setReadOnly(readOnly: boolean): void {
    this.readOnly = Boolean(readOnly);
    this.host?.setReadOnly(this.readOnly);
  }

  // -----------------------------------------------------------------------
  // Host 绑定
  // -----------------------------------------------------------------------

  /**
   * 绑定 / 替换 host。将当前 content / language / readOnly / focus 推到 host。
   */
  attachHost(host: CodeLeafHost): void {
    if (this.host && this.host !== host) {
      this.host.destroy();
    }
    this.host = host;
    host.setContent(this.content);
    host.setReadOnly(this.readOnly);
    host.setLanguage?.(this.language);
    if (this.focused) {
      host.focus();
    } else {
      host.blur();
    }
  }

  /** 解绑 host（destroy）；模型 content 保留 */
  detachHost(): void {
    if (this.host) {
      this.host.destroy();
      this.host = null;
    }
  }

  getHost(): CodeLeafHost | null {
    return this.host;
  }

  // -----------------------------------------------------------------------
  // 投影回填（不产生 Intent）
  // -----------------------------------------------------------------------

  /**
   * 以投影/权威文本覆盖本地缓冲。
   * composing 期间 **拒绝**；返回是否已写入。
   */
  replaceFromProjection(content: string): boolean {
    if (this.composing || resolveFlag(this.externalIsComposing)) {
      return false;
    }
    this.content = content;
    this.host?.setContent(content);
    return true;
  }

  // -----------------------------------------------------------------------
  // 本地编辑 → Intent
  // -----------------------------------------------------------------------

  /**
   * 本地区间替换：`content[start, end) ← insert`。
   *
   * - **readOnly**：拒绝，返回 null，content 不变
   * - 始终在可写时更新本地缓冲 + host
   * - **composing**（本地或外部）：仅更新缓冲，返回 null
   * - **非 composing**：返回新 `TextEditIntent`
   *
   * 不强制焦点（与 TextLeaf 对称）；需要「失焦拒绝」请用 `tryApplyLocalEdit`。
   */
  applyLocalEdit(
    start: number,
    end: number,
    insert: string
  ): TextEditIntent | null {
    const attempt = this.tryApplyLocalEdit(start, end, insert, {
      requireFocus: false,
    });
    if (!attempt.ok) {
      return null;
    }
    return attempt.intent;
  }

  /**
   * 显式结果版编辑：只读 / 可选失焦带拒绝码。
   *
   * @param options.requireFocus 默认 true——W3-E「可聚焦」验收路径用此
   */
  tryApplyLocalEdit(
    start: number,
    end: number,
    insert: string,
    options: { requireFocus?: boolean } = {}
  ): CodeEditAttempt {
    const requireFocus = options.requireFocus !== false;

    if (this.readOnly) {
      return {
        ok: false,
        code: 'read_only',
        reason: 'CodeLeafModel：只读代码叶拒绝编辑',
      };
    }

    if (requireFocus && !this.focused) {
      return {
        ok: false,
        code: 'not_focused',
        reason: 'CodeLeafModel：未聚焦时拒绝编辑（先 focus()）',
      };
    }

    const len = this.content.length;
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end < start ||
      end > len
    ) {
      // 越界仍 clamp 以对齐 TextLeaf 宽容语义；仅 NaN / 反向视为 invalid
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        return {
          ok: false,
          code: 'invalid_range',
          reason: 'CodeLeafModel：非法 range',
        };
      }
    }

    const s = clampOffset(start, 0, len);
    const e = clampOffset(end, s, len);
    const ins = insert ?? '';

    this.content = this.content.slice(0, s) + ins + this.content.slice(e);
    this.host?.setContent(this.content);

    if (this.composing || resolveFlag(this.externalIsComposing)) {
      return { ok: true, intent: null, content: this.content };
    }

    return {
      ok: true,
      intent: this.buildTextEditIntent(s, e, ins),
      content: this.content,
    };
  }

  // -----------------------------------------------------------------------
  // Composition（与 TextLeaf 同构；可选对接外部 isComposing）
  // -----------------------------------------------------------------------

  /**
   * 进入 composition。
   * @param anchorOffset 合成插入点
   * @param replaceEnd 替换选区 end；缺省 = anchor
   */
  beginComposition(anchorOffset: number, replaceEnd?: number): void {
    if (this.composing) {
      return;
    }
    if (this.readOnly) {
      return;
    }
    const len = this.content.length;
    const anchor = clampOffset(anchorOffset, 0, len);
    const end =
      replaceEnd === undefined ? anchor : clampOffset(replaceEnd, anchor, len);

    this.composing = true;
    this.compositionAnchor = anchor;
    this.compositionReplaceEnd = end;
    this.preCompositionContent = this.content;
  }

  /**
   * compositionend 刷新：产出覆盖合成区间的 `text_edit`。
   * 结束后 `composing === false`（本地态）。
   */
  flushOnCompositionEnd(finalInsert?: string): TextEditIntent | null {
    if (!this.composing) {
      return null;
    }

    if (this.readOnly) {
      this.clearCompositionState(true);
      return null;
    }

    const pre = this.preCompositionContent ?? this.content;
    const anchor = this.compositionAnchor ?? 0;
    const replaceEnd = this.compositionReplaceEnd ?? anchor;

    let insert: string;
    if (finalInsert !== undefined) {
      insert = finalInsert;
      this.content = pre.slice(0, anchor) + insert + pre.slice(replaceEnd);
    } else {
      const suffix = pre.slice(replaceEnd);
      if (suffix.length > 0 && this.content.endsWith(suffix)) {
        insert = this.content.slice(
          anchor,
          this.content.length - suffix.length
        );
      } else {
        insert = this.content.slice(anchor);
      }
    }

    this.clearCompositionState(false);
    this.host?.setContent(this.content);
    return this.buildTextEditIntent(anchor, replaceEnd, insert);
  }

  /** 取消 composition：回滚，不发 Intent */
  cancelComposition(): void {
    if (!this.composing) return;
    this.clearCompositionState(true);
    this.host?.setContent(this.content);
  }

  // -----------------------------------------------------------------------
  // 内部
  // -----------------------------------------------------------------------

  private clearCompositionState(rollback: boolean): void {
    if (rollback && this.preCompositionContent != null) {
      this.content = this.preCompositionContent;
    }
    this.composing = false;
    this.compositionAnchor = null;
    this.compositionReplaceEnd = null;
    this.preCompositionContent = null;
  }

  private buildTextEditIntent(
    start: number,
    end: number,
    insert: string
  ): TextEditIntent {
    return {
      type: 'text_edit',
      blockId: this.blockId,
      range: [start, end],
      insert,
      intentId: this.createIntentId(),
    };
  }
}
