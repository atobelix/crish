import { escapeHtml } from '../markdownRenderLite';
import {
  consumeIncrementalInlineText,
  consumeIncrementalInlineToken,
  cancelIncrementalPreviewParts,
  type IncrementalMarkdownInlineContext,
  type IncrementalMarkdownInlineToken,
} from './IncrementalMarkdownInline';
import {
  consumeIncrementalMarkdownFence,
  type IncrementalMarkdownFenceState,
} from './IncrementalMarkdownFence';
import type { IncrementalMarkdownConsumeContext } from './IncrementalMarkdownConsume';
import type {
  IncrementalMarkdownFragmentKind,
  IncrementalMarkdownTextPart,
} from './IncrementalMarkdownSession';
import {
  IncrementalMarkdownUnitProjection,
  type IncrementalMarkdownUnitState,
} from './IncrementalMarkdownUnits';

/**
 * 活跃 Markdown 块的结构状态机：持有行首探测、围栏、段落/标题/列表/引用
 * 的开闭状态，并把结构包装器写入 HTML 单元投影。
 *
 * 本类直接实现 consume 上下文接口：`consumeIncrementalMarkdown` 读写的就是
 * 本实例字段（同一份状态），不需要再用访问器把上下文镜像回会话实例。
 * 行内与围栏子状态机仍按「拷入 → 推进 → 回写」的快照语义协作，与拆分前一致。
 */
export class IncrementalMarkdownBlockBuilder implements IncrementalMarkdownConsumeContext {
  public readonly projection = new IncrementalMarkdownUnitProjection();

  /** 尚未确定是结构前缀还是普通文本的行首字符。 */
  public lineProbe = '';
  public lineStart = true;

  public fenceChar: '`' | '~' | null = null;
  private fenceLineProbe = '';
  private fenceLineStart = true;

  public paragraphOpen = false;
  public headingLevel: number | null = null;
  public blockquoteOpen = false;
  public listTag: 'ul' | 'ol' | null = null;
  public listItemOpen = false;
  public listBreakPending = false;

  /** 普通段落的换行先保留到下一字符，以识别 setext 标题。 */
  public pendingNewline = false;
  public previousLineEligibleForSetext = false;
  public setextHeadingLine = false;
  public currentLineHasContent = false;

  public inlineToken: IncrementalMarkdownInlineToken | null = null;
  public pendingInput = '';

  /** 清空投影与全部结构状态；投影实例保留，单元/片段 id 继续单调递增。 */
  public reset(): void {
    this.projection.reset();
    this.lineProbe = '';
    this.lineStart = true;
    this.fenceChar = null;
    this.fenceLineProbe = '';
    this.fenceLineStart = true;
    this.paragraphOpen = false;
    this.headingLevel = null;
    this.blockquoteOpen = false;
    this.listTag = null;
    this.listItemOpen = false;
    this.listBreakPending = false;
    this.pendingNewline = false;
    this.previousLineEligibleForSetext = false;
    this.setextHeadingLine = false;
    this.currentLineHasContent = false;
    this.inlineToken = null;
    this.pendingInput = '';
  }

  /** 单元已生成的 HTML，加上仍处于打开状态时临时补齐的闭合标签。 */
  public renderUnitHtml(unit: IncrementalMarkdownUnitState): string {
    return `${unit.html}${this.projection.openUnitSuffix(
      unit,
      this.listItemOpen,
      this.listTag
    )}`;
  }

  public consumeInlineText(
    text: string,
    textParts: IncrementalMarkdownTextPart[],
    fragmentKind: IncrementalMarkdownFragmentKind = 'inline'
  ): void {
    const context = this.createInlineContext();
    consumeIncrementalInlineText(context, text, textParts, fragmentKind);
    this.syncInlineContext(context);
  }

  public consumeInlineToken(
    input: string,
    index: number,
    textParts: IncrementalMarkdownTextPart[],
    fragmentKind: IncrementalMarkdownFragmentKind = 'inline'
  ): number | null {
    const context = this.createInlineContext();
    const next = consumeIncrementalInlineToken(
      context,
      input,
      index,
      textParts,
      fragmentKind
    );
    this.syncInlineContext(context);
    return next;
  }

  private createInlineContext(): IncrementalMarkdownInlineContext {
    return {
      inlineToken: this.inlineToken,
      pendingInput: this.pendingInput,
      currentLineHasContent: this.currentLineHasContent,
      ensureInlineContainer: () => this.ensureInlineContainer(),
      handleInlineNewline: () => this.handleInlineNewline(),
      appendFragment: (source, kind) =>
        this.projection.appendFragment(source, kind),
      cancelPreviewParts: (ids) =>
        cancelIncrementalPreviewParts(this.projection.parts, ids, (unitId) =>
          this.projection.refreshUnitHtml(unitId)
        ),
    };
  }

  private syncInlineContext(context: IncrementalMarkdownInlineContext): void {
    this.inlineToken = context.inlineToken;
    this.pendingInput = context.pendingInput;
    this.currentLineHasContent = context.currentLineHasContent;
  }

  public handleInlineNewline(): void {
    if (this.listItemOpen) {
      this.listBreakPending = true;
      this.lineStart = true;
      this.currentLineHasContent = false;
      return;
    }
    if (this.headingLevel !== null) {
      this.closeHeading();
      this.lineStart = true;
      this.currentLineHasContent = false;
      return;
    }
    if (this.blockquoteOpen) {
      this.closeBlockquote();
      this.lineStart = true;
      this.currentLineHasContent = false;
      return;
    }
    if (this.paragraphOpen) {
      this.pendingNewline = true;
      this.previousLineEligibleForSetext =
        this.currentLineHasContent && this.inlineToken === null;
      this.currentLineHasContent = false;
      this.lineStart = true;
      return;
    }
    this.lineStart = true;
  }

  public consumeFence(input: string, start: number): number | null {
    const state: IncrementalMarkdownFenceState = {
      fenceChar: this.fenceChar,
      fenceLineProbe: this.fenceLineProbe,
      fenceLineStart: this.fenceLineStart,
      lineStart: this.lineStart,
    };
    const next = consumeIncrementalMarkdownFence(state, input, start, {
      appendCodeText: (value) => {
        if (value) this.projection.appendStatic(escapeHtml(value));
      },
      closeCode: () => this.closeCode(),
    });
    this.fenceChar = state.fenceChar;
    this.fenceLineProbe = state.fenceLineProbe;
    this.fenceLineStart = state.fenceLineStart;
    this.lineStart = state.lineStart;
    return next;
  }

  public ensureInlineContainer(): void {
    if (
      this.paragraphOpen ||
      this.headingLevel !== null ||
      this.listItemOpen ||
      this.blockquoteOpen
    ) {
      return;
    }
    this.openParagraph();
  }

  private openParagraph(): void {
    if (this.paragraphOpen) return;
    this.projection.beginUnit('paragraph', '<p class="md-p">');
    this.paragraphOpen = true;
  }

  public closeParagraph(): void {
    if (!this.paragraphOpen) return;
    this.pendingNewline = false;
    this.previousLineEligibleForSetext = false;
    this.projection.endUnit('</p>');
    this.paragraphOpen = false;
  }

  public openHeading(level: number): void {
    this.projection.beginUnit('heading', `<h${level} class="md-h${level}">`);
    const unit = this.projection.units[this.projection.units.length - 1];
    if (unit) unit.level = level;
    this.headingLevel = level;
  }

  public closeHeading(): void {
    if (this.headingLevel === null) return;
    this.projection.endUnit(`</h${this.headingLevel}>`);
    this.headingLevel = null;
  }

  public convertParagraphToSetext(level: number): void {
    const unit =
      this.projection.activeUnitId === null
        ? null
        : (this.projection.units.find(
            (candidate) => candidate.id === this.projection.activeUnitId
          ) ?? null);
    if (!unit || unit.kind !== 'paragraph') return;
    for (const part of this.projection.parts) {
      if (part.unitId !== unit.id || part.kind !== 'static') continue;
      if (part.value === '<p class="md-p">') {
        part.value = `<h${level} class="md-h${level}">`;
        break;
      }
    }
    this.projection.refreshUnitHtml(unit.id);
    unit.kind = 'heading';
    unit.level = level;
    this.paragraphOpen = false;
    this.headingLevel = level;
  }

  public openList(tag: 'ul' | 'ol', start?: number): void {
    const className = tag === 'ol' ? 'md-ol' : 'md-ul';
    const startAttr =
      tag === 'ol' && start && start > 1 ? ` start="${start}"` : '';
    this.projection.beginUnit(
      'list',
      `<${tag} class="${className}"${startAttr}>`
    );
    const unit = this.projection.units[this.projection.units.length - 1];
    if (unit) unit.tag = tag;
    this.listTag = tag;
  }

  public openListItem(itemClass: string, taskPrefix?: string): void {
    if (this.listItemOpen) this.closeListItem();
    this.projection.appendStatic(
      `<li class="${itemClass}">${taskPrefix ?? ''}`
    );
    this.listItemOpen = true;
  }

  public closeListItem(): void {
    if (!this.listItemOpen) return;
    this.projection.appendStatic('</li>');
    this.listItemOpen = false;
  }

  public closeList(): void {
    if (!this.listTag) return;
    this.closeListItem();
    this.projection.endUnit(`</${this.listTag}>`);
    this.listTag = null;
    this.listBreakPending = false;
  }

  public openBlockquote(): void {
    if (this.blockquoteOpen) return;
    this.projection.beginUnit('blockquote', '<blockquote><p class="md-p">');
    this.blockquoteOpen = true;
  }

  public closeBlockquote(): void {
    if (!this.blockquoteOpen) return;
    this.projection.endUnit('</p></blockquote>');
    this.blockquoteOpen = false;
  }

  public openCode(char: '`' | '~', info: string): void {
    const rawLanguage = (info.trim().split(/\s+/)[0] ?? '')
      .replace(/^language-/i, '')
      .replace(/^\./, '')
      .replace(/[^a-zA-Z0-9_+-]/g, '');
    const attr = rawLanguage ? ` data-lang="${escapeHtml(rawLanguage)}"` : '';
    const className = `language-${escapeHtml(rawLanguage)}`;
    this.projection.beginUnit(
      'code',
      `<div class="md-code-block"${attr}><pre class="md-code-pre hljs"><code class="${className}">`
    );
    this.fenceChar = char;
    this.fenceLineStart = true;
    this.fenceLineProbe = '';
  }

  private closeCode(): void {
    if (!this.fenceChar) return;
    this.projection.appendStatic('</code></pre></div>');
    this.projection.endUnit();
    this.fenceChar = null;
    this.fenceLineStart = true;
    this.fenceLineProbe = '';
  }

  public flushPendingNewline(): void {
    if (!this.pendingNewline) return;
    this.projection.appendStatic('<br />');
    this.pendingNewline = false;
    this.previousLineEligibleForSetext = false;
  }
}
