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
/** 消费上下文里需要与本实例共享同一份状态的标量键 */
type MirroredConsumeStateKey =
  | 'lineProbe'
  | 'lineStart'
  | 'fenceChar'
  | 'setextHeadingLine'
  | 'pendingInput'
  | 'pendingNewline'
  | 'previousLineEligibleForSetext'
  | 'currentLineHasContent'
  | 'inlineToken'
  | 'paragraphOpen'
  | 'headingLevel'
  | 'blockquoteOpen'
  | 'listTag'
  | 'listItemOpen'
  | 'listBreakPending';

/** 上下文的方法面（标量状态由访问器后置安装） */
type ConsumeMethodSurface = Omit<
  IncrementalMarkdownConsumeContext,
  MirroredConsumeStateKey
>;

/**
 * 生成读写都落在调用方提供的 get/set 上的属性描述符：
 * 让上下文视图与本实例共享同一份状态（而不是拷贝快照）。
 */
function mirroredField<V>(
  get: () => V,
  set: (value: V) => void
): PropertyDescriptor {
  return { get, set, enumerable: true, configurable: true };
}

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

  /** 首次消费时装配的上下文视图；标量字段实时转发到上面这些字段（同一份状态）。 */
  private consumeContext: IncrementalMarkdownConsumeContext | null = null;

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

  public advance(
    nextSource: string,
    includeHtml = true
  ): IncrementalMarkdownAdvance {
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
      .map(
        (unit) =>
          `${unit.html}${this.projection.openUnitSuffix(
            unit,
            this.listItemOpen,
            this.listTag
          )}`
      )
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
    this.consumeContext ??= this.buildConsumeContext();
    return this.consumeContext;
  }

  /**
   * 装配 consume 上下文：上下文里的标量字段必须在消费过程中与本实例**同一份状态**，
   * 因此用访问器实时转发到本实例字段（箭头闭包捕获 this，不做 `const self = this` 别名）。
   * 访问器只在首次消费时安装一次，避免逐 delta 的 defineProperty 开销。
   */
  private buildConsumeContext(): IncrementalMarkdownConsumeContext {
    // 方法面按上下文接口做上下文类型标注，箭头闭包内 this 指向本实例（无需 self 别名）
    const context: ConsumeMethodSurface = {
      projection: this.projection,
      consumeFence: (input, start) => this.consumeFence(input, start),
      consumeInlineToken: (input, index, textParts, fragmentKind) =>
        this.consumeInlineToken(input, index, textParts, fragmentKind),
      consumeInlineText: (text, textParts, fragmentKind) => {
        this.consumeInlineText(text, textParts, fragmentKind);
      },
      handleInlineNewline: () => this.handleInlineNewline(),
      ensureInlineContainer: () => this.ensureInlineContainer(),
      flushPendingNewline: () => this.flushPendingNewline(),
      closeHeading: () => this.closeHeading(),
      closeParagraph: () => this.closeParagraph(),
      closeList: () => this.closeList(),
      closeBlockquote: () => this.closeBlockquote(),
      openCode: (char, info) => this.openCode(char, info),
      openHeading: (level) => this.openHeading(level),
      openList: (tag, start) => this.openList(tag, start),
      closeListItem: () => this.closeListItem(),
      openListItem: (itemClass, taskPrefix) =>
        this.openListItem(itemClass, taskPrefix),
      openBlockquote: () => this.openBlockquote(),
      convertParagraphToSetext: (level) => this.convertParagraphToSetext(level),
    };
    Object.defineProperties(context, {
      lineProbe: mirroredField(
        () => this.lineProbe,
        (value) => {
          this.lineProbe = value;
        }
      ),
      lineStart: mirroredField(
        () => this.lineStart,
        (value) => {
          this.lineStart = value;
        }
      ),
      fenceChar: mirroredField(
        () => this.fenceChar,
        (value) => {
          this.fenceChar = value;
        }
      ),
      setextHeadingLine: mirroredField(
        () => this.setextHeadingLine,
        (value) => {
          this.setextHeadingLine = value;
        }
      ),
      pendingInput: mirroredField(
        () => this.pendingInput,
        (value) => {
          this.pendingInput = value;
        }
      ),
      pendingNewline: mirroredField(
        () => this.pendingNewline,
        (value) => {
          this.pendingNewline = value;
        }
      ),
      previousLineEligibleForSetext: mirroredField(
        () => this.previousLineEligibleForSetext,
        (value) => {
          this.previousLineEligibleForSetext = value;
        }
      ),
      currentLineHasContent: mirroredField(
        () => this.currentLineHasContent,
        (value) => {
          this.currentLineHasContent = value;
        }
      ),
      inlineToken: mirroredField(
        () => this.inlineToken,
        (value) => {
          this.inlineToken = value;
        }
      ),
      paragraphOpen: mirroredField(
        () => this.paragraphOpen,
        (value) => {
          this.paragraphOpen = value;
        }
      ),
      headingLevel: mirroredField(
        () => this.headingLevel,
        (value) => {
          this.headingLevel = value;
        }
      ),
      blockquoteOpen: mirroredField(
        () => this.blockquoteOpen,
        (value) => {
          this.blockquoteOpen = value;
        }
      ),
      listTag: mirroredField(
        () => this.listTag,
        (value) => {
          this.listTag = value;
        }
      ),
      listItemOpen: mirroredField(
        () => this.listItemOpen,
        (value) => {
          this.listItemOpen = value;
        }
      ),
      listBreakPending: mirroredField(
        () => this.listBreakPending,
        (value) => {
          this.listBreakPending = value;
        }
      ),
    });
    // 标量字段由上面的访问器补齐，此处收窄为本模块唯一一处结构断言（非 any、非双重断言）
    return context as IncrementalMarkdownConsumeContext;
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

  private openList(tag: 'ul' | 'ol', start?: number): void {
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

  private openListItem(itemClass: string, taskPrefix?: string): void {
    if (this.listItemOpen) this.closeListItem();
    this.projection.appendStatic(
      `<li class="${itemClass}">${taskPrefix ?? ''}`
    );
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
