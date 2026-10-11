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
import {
  consumeIncrementalMarkdown,
  type IncrementalMarkdownConsumeContext,
} from './IncrementalMarkdownConsume';
import { IncrementalMarkdownUnitProjection } from './IncrementalMarkdownUnits';

export type IncrementalMarkdownFragmentKind = 'inline' | 'block' | 'list-item';

export interface IncrementalMarkdownTextPart {
  id: number;
  source: string;
  kind: IncrementalMarkdownFragmentKind;
}

export interface IncrementalMarkdownAdvance {
  revision: number;
  reset: boolean;
  textParts: IncrementalMarkdownTextPart[];
  html: string;
}

export type IncrementalMarkdownUnitKind =
  | 'paragraph'
  | 'heading'
  | 'list'
  | 'block'
  | 'code'
  | 'blockquote'
  | 'hr'
  | 'other';

/** 活跃流式块的根单元快照；消费者只需解析发生变化的单元。 */
export interface IncrementalMarkdownUnitSnapshot {
  id: number;
  kind: IncrementalMarkdownUnitKind;
  html: string;
}

export type HtmlPart =
  | { kind: 'static'; unitId: number | null; value: string }
  | {
    kind: 'text';
    id: number;
    unitId: number | null;
    value: string;
    cancelled?: boolean;
  };

/**
 * 维护一个活跃 Markdown 块的安全 HTML 投影。
 *
 * 这不是把累计 Markdown 再交给 renderer。普通文本、标题正文、列表正文
 * 和已闭合的行内 token 都只把新增的有界片段交给现有安全 renderer；代码
 * 围栏的正文直接按新增字符做 HTML 转义。结构包装器由状态机维护，因此
 * 标题、列表项和长代码行在语法尚未封口时也能进入 DOM，并且任何失败都
 * 保持空白，绝不把 Markdown 源码当作 HTML 回退。
 */
export class IncrementalMarkdownSession {
  private source = '';
  private revision = 0;
  private readonly projection = new IncrementalMarkdownUnitProjection();

  /** 尚未确定是结构前缀还是普通文本的行首字符。 */
  private lineProbe = '';
  private lineStart = true;

  private fenceChar: '`' | '~' | null = null;
  private fenceLineProbe = '';
  private fenceLineStart = true;

  private paragraphOpen = false;
  private headingLevel: number | null = null;
  private blockquoteOpen = false;
  private listTag: 'ul' | 'ol' | null = null;
  private listItemOpen = false;
  private listBreakPending = false;

  /** 普通段落的换行先保留到下一字符，以识别 setext 标题。 */
  private pendingNewline = false;
  private previousLineEligibleForSetext = false;
  private setextHeadingLine = false;
  private currentLineHasContent = false;

  private inlineToken: IncrementalMarkdownInlineToken | null = null;
  private pendingInput = '';

  constructor() {
    this.resetProjection();
  }

  public getRevision(): number {
    return this.revision;
  }

  public reset(): void {
    this.revision += 1;
    this.source = '';
    this.resetProjection();
  }

  public advance(nextSource: string, includeHtml = true): IncrementalMarkdownAdvance {
    const normalized = nextSource.replace(/\r\n?/g, '\n');
    const reset = this.source.length > 0 && !normalized.startsWith(this.source);

    if (reset) {
      this.revision += 1;
      this.source = '';
      this.resetProjection();
    }

    const delta = normalized.slice(this.source.length);
    this.source = normalized;
    const textParts = delta ? this.consume(delta) : [];

    return {
      revision: this.revision,
      reset,
      textParts,
      html: includeHtml ? this.toHtml() : '',
    };
  }

  public resolveTextPart(id: number, html: string): boolean {
    for (const part of this.projection.parts) {
      if (part.kind === 'text' && part.id === id && !part.cancelled) {
        part.value = html;
        this.projection.refreshUnitHtml(part.unitId);
        return true;
      }
    }
    return false;
  }

  /** 返回按根结构单元分组的 HTML；稳定单元无需在消费者侧重新解析。 */
  public getUnitSnapshots(): IncrementalMarkdownUnitSnapshot[] {
    return this.projection.units.map((unit) => {
      return {
        id: unit.id,
        kind: unit.kind,
        html: `${unit.html}${this.projection.openUnitSuffix(
          unit,
          this.listItemOpen,
          this.listTag
        )}`,
      };
    });
  }

  public toHtml(): string {
    return this.projection.units
      .map((unit) => `${unit.html}${this.projection.openUnitSuffix(
        unit,
        this.listItemOpen,
        this.listTag
      )}`)
      .join('');
  }

  private resetProjection(): void {
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

  private consume(delta: string): IncrementalMarkdownTextPart[] {
    return consumeIncrementalMarkdown(this.createConsumeContext(), delta);
  }

  private createConsumeContext(): IncrementalMarkdownConsumeContext {
    const self = this;
    return {
      get lineProbe() { return self.lineProbe; }, set lineProbe(value) { self.lineProbe = value; },
      get lineStart() { return self.lineStart; }, set lineStart(value) { self.lineStart = value; },
      get fenceChar() { return self.fenceChar; }, set fenceChar(value) { self.fenceChar = value; },
      get setextHeadingLine() { return self.setextHeadingLine; }, set setextHeadingLine(value) { self.setextHeadingLine = value; },
      get pendingInput() { return self.pendingInput; }, set pendingInput(value) { self.pendingInput = value; },
      get pendingNewline() { return self.pendingNewline; }, set pendingNewline(value) { self.pendingNewline = value; },
      get previousLineEligibleForSetext() { return self.previousLineEligibleForSetext; }, set previousLineEligibleForSetext(value) { self.previousLineEligibleForSetext = value; },
      get currentLineHasContent() { return self.currentLineHasContent; }, set currentLineHasContent(value) { self.currentLineHasContent = value; },
      get inlineToken() { return self.inlineToken; }, set inlineToken(value) { self.inlineToken = value; },
      get paragraphOpen() { return self.paragraphOpen; }, set paragraphOpen(value) { self.paragraphOpen = value; },
      get headingLevel() { return self.headingLevel; }, set headingLevel(value) { self.headingLevel = value; },
      get blockquoteOpen() { return self.blockquoteOpen; }, set blockquoteOpen(value) { self.blockquoteOpen = value; },
      get listTag() { return self.listTag; }, set listTag(value) { self.listTag = value; },
      get listItemOpen() { return self.listItemOpen; }, set listItemOpen(value) { self.listItemOpen = value; },
      get listBreakPending() { return self.listBreakPending; }, set listBreakPending(value) { self.listBreakPending = value; },
      projection: self.projection,
      consumeFence: (input, start) => self.consumeFence(input, start),
      consumeInlineToken: (input, index, textParts, fragmentKind) => (
        self.consumeInlineToken(input, index, textParts, fragmentKind)
      ),
      consumeInlineText: (text, textParts, fragmentKind) => {
        self.consumeInlineText(text, textParts, fragmentKind);
      },
      handleInlineNewline: () => self.handleInlineNewline(),
      ensureInlineContainer: () => self.ensureInlineContainer(),
      flushPendingNewline: () => self.flushPendingNewline(),
      closeHeading: () => self.closeHeading(),
      closeParagraph: () => self.closeParagraph(),
      closeList: () => self.closeList(),
      closeBlockquote: () => self.closeBlockquote(),
      openCode: (char, info) => self.openCode(char, info),
      openHeading: (level) => self.openHeading(level),
      openList: (tag, start) => self.openList(tag, start),
      closeListItem: () => self.closeListItem(),
      openListItem: (itemClass, taskPrefix) => self.openListItem(itemClass, taskPrefix),
      openBlockquote: () => self.openBlockquote(),
      convertParagraphToSetext: (level) => self.convertParagraphToSetext(level),
    };
  }

  private consumeInlineText(
    text: string,
    textParts: IncrementalMarkdownTextPart[],
    fragmentKind: IncrementalMarkdownFragmentKind = 'inline'
  ): void {
    const context = this.createInlineContext();
    consumeIncrementalInlineText(context, text, textParts, fragmentKind);
    this.syncInlineContext(context);
  }

  private consumeInlineToken(
    input: string,
    index: number,
    textParts: IncrementalMarkdownTextPart[],
    fragmentKind: IncrementalMarkdownFragmentKind = 'inline'
  ): number | null {
    const context = this.createInlineContext();
    const next = consumeIncrementalInlineToken(context, input, index, textParts, fragmentKind);
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
      appendFragment: (source, kind) => this.projection.appendFragment(source, kind),
      cancelPreviewParts: (ids) => cancelIncrementalPreviewParts(
        this.projection.parts,
        ids,
        (unitId) => this.projection.refreshUnitHtml(unitId)
      ),
    };
  }

  private syncInlineContext(context: IncrementalMarkdownInlineContext): void {
    this.inlineToken = context.inlineToken;
    this.pendingInput = context.pendingInput;
    this.currentLineHasContent = context.currentLineHasContent;
  }

  private handleInlineNewline(): void {
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

  private consumeFence(input: string, start: number): number | null {
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

  private ensureInlineContainer(): void {
    if (this.paragraphOpen || this.headingLevel !== null || this.listItemOpen || this.blockquoteOpen) {
      return;
    }
    this.openParagraph();
  }

  private openParagraph(): void {
    if (this.paragraphOpen) return;
    this.projection.beginUnit('paragraph', '<p class="md-p">');
    this.paragraphOpen = true;
  }

  private closeParagraph(): void {
    if (!this.paragraphOpen) return;
    this.pendingNewline = false;
    this.previousLineEligibleForSetext = false;
    this.projection.endUnit('</p>');
    this.paragraphOpen = false;
  }

  private openHeading(level: number): void {
    this.projection.beginUnit('heading', `<h${level} class="md-h${level}">`);
    const unit = this.projection.units[this.projection.units.length - 1];
    if (unit) unit.level = level;
    this.headingLevel = level;
  }

  private closeHeading(): void {
    if (this.headingLevel === null) return;
    this.projection.endUnit(`</h${this.headingLevel}>`);
    this.headingLevel = null;
  }

  private convertParagraphToSetext(level: number): void {
    const unit = this.projection.activeUnitId === null
      ? null
      : this.projection.units.find((candidate) => candidate.id === this.projection.activeUnitId) ?? null;
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

  private openList(tag: 'ul' | 'ol', start?: number): void {
    const className = tag === 'ol' ? 'md-ol' : 'md-ul';
    const startAttr = tag === 'ol' && start && start > 1 ? ` start="${start}"` : '';
    this.projection.beginUnit('list', `<${tag} class="${className}"${startAttr}>`);
    const unit = this.projection.units[this.projection.units.length - 1];
    if (unit) unit.tag = tag;
    this.listTag = tag;
  }

  private openListItem(itemClass: string, taskPrefix?: string): void {
    if (this.listItemOpen) this.closeListItem();
    this.projection.appendStatic(`<li class="${itemClass}">${taskPrefix ?? ''}`);
    this.listItemOpen = true;
  }

  private closeListItem(): void {
    if (!this.listItemOpen) return;
    this.projection.appendStatic('</li>');
    this.listItemOpen = false;
  }

  private closeList(): void {
    if (!this.listTag) return;
    this.closeListItem();
    this.projection.endUnit(`</${this.listTag}>`);
    this.listTag = null;
    this.listBreakPending = false;
  }

  private openBlockquote(): void {
    if (this.blockquoteOpen) return;
    this.projection.beginUnit('blockquote', '<blockquote><p class="md-p">');
    this.blockquoteOpen = true;
  }

  private closeBlockquote(): void {
    if (!this.blockquoteOpen) return;
    this.projection.endUnit('</p></blockquote>');
    this.blockquoteOpen = false;
  }

  private openCode(char: '`' | '~', info: string): void {
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

  private flushPendingNewline(): void {
    if (!this.pendingNewline) return;
    this.projection.appendStatic('<br />');
    this.pendingNewline = false;
    this.previousLineEligibleForSetext = false;
  }

}
