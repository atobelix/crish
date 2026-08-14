/**
 * CM6 代码叶本地模型（W3-E 方向子集 · SD-54 再抽）。
 *
 * 类型 / 快照 / helpers → `CodeLeafModel.types`；IME / 只读留本 class。
 * 既有 `from './CodeLeafModel'` 与 `from './index'` 公开面不断。
 *
 * 对齐：`text_edit` Intent；可聚焦；只读拒绝；A-IME 缓冲 flush；
 * 写路径 Intent → submitIntent → sink（**禁止** serialize(DOM)）。
 * flavour / fence → `codeFlavourMap`（本刀不改）。Host 经 `CodeLeafHost`。
 *
 * ## 诚实边界
 * - **SD-54 再抽**；**≠** EL-01；**≠** A-BLK-14 产品 focus e2e
 * - **≠** 占 W3-E 首批；**≠** 改 flavour / fence 映射
 * - **≠** 全语言高亮完成：language 字段 + Compartment 钩子就位
 */

import type {
  BlockId,
  IntentId,
  TextEditIntent,
} from '@crish/block-paper-contract';
import { nextIntentId } from '../../intentId';
import type { CodeLeafHost } from './CodeLeafHost';
import {
  buildCodeTextEditIntent,
  clampOffset,
  resolveFlag,
  type CodeLanguage,
  type CodeLeafSnapshot,
  type CodeLeafModelOptions,
  type CodeEditAttempt,
} from './CodeLeafModel.types';

export type {
  CodeLanguage,
  CodeLeafSnapshot,
  CodeLeafModelOptions,
  CodeEditRejectCode,
  CodeEditAttempt,
} from './CodeLeafModel.types';

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

  // -- 读

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

  // -- 焦点

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

  // -- 元数据

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

  // -- Host 绑定

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

  // -- 投影回填（不产生 Intent）

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

  // -- 本地编辑 → Intent

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

    const oldContent = this.content;
    const len = oldContent.length;
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

    this.content = oldContent.slice(0, s) + ins + oldContent.slice(e);
    this.host?.setContent(this.content);

    if (this.composing || resolveFlag(this.externalIsComposing)) {
      return { ok: true, intent: null, content: this.content };
    }

    return {
      ok: true,
      intent: buildCodeTextEditIntent(
        this.blockId,
        s,
        e,
        ins,
        this.createIntentId(),
        oldContent
      ),
      content: this.content,
    };
  }

  // -- Composition（与 TextLeaf 同构；可选对接外部 isComposing）

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
    return buildCodeTextEditIntent(
      this.blockId,
      anchor,
      replaceEnd,
      insert,
      this.createIntentId(),
      pre
    );
  }

  /** 取消 composition：回滚，不发 Intent */
  cancelComposition(): void {
    if (!this.composing) return;
    this.clearCompositionState(true);
    this.host?.setContent(this.content);
  }

  // -- 内部

  private clearCompositionState(rollback: boolean): void {
    if (rollback && this.preCompositionContent != null) {
      this.content = this.preCompositionContent;
    }
    this.composing = false;
    this.compositionAnchor = null;
    this.compositionReplaceEnd = null;
    this.preCompositionContent = null;
  }
}
