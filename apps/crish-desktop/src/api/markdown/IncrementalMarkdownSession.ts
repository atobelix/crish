import { consumeIncrementalMarkdown } from './IncrementalMarkdownConsume';
import { IncrementalMarkdownBlockBuilder } from './IncrementalMarkdownBlockBuilder';

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
 *
 * 本类只负责源文本的增量对齐（前缀延续 / 重置）与修订号；结构状态机与
 * HTML 单元投影在 IncrementalMarkdownBlockBuilder 中。
 */
export class IncrementalMarkdownSession {
  private source = '';
  private revision = 0;
  private readonly builder = new IncrementalMarkdownBlockBuilder();

  public getRevision(): number {
    return this.revision;
  }

  public reset(): void {
    this.revision += 1;
    this.source = '';
    this.builder.reset();
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
      this.builder.reset();
    }

    const delta = normalized.slice(this.source.length);
    this.source = normalized;
    const textParts = delta
      ? consumeIncrementalMarkdown(this.builder, delta)
      : [];

    return {
      revision: this.revision,
      reset,
      textParts,
      html: includeHtml ? this.toHtml() : '',
    };
  }

  public resolveTextPart(id: number, html: string): boolean {
    const { projection } = this.builder;
    for (const part of projection.parts) {
      if (part.kind === 'text' && part.id === id && !part.cancelled) {
        part.value = html;
        projection.refreshUnitHtml(part.unitId);
        return true;
      }
    }
    return false;
  }

  /** 返回按根结构单元分组的 HTML；稳定单元无需在消费者侧重新解析。 */
  public getUnitSnapshots(): IncrementalMarkdownUnitSnapshot[] {
    return this.builder.projection.units.map((unit) => ({
      id: unit.id,
      kind: unit.kind,
      html: this.builder.renderUnitHtml(unit),
    }));
  }

  public toHtml(): string {
    return this.builder.projection.units
      .map((unit) => this.builder.renderUnitHtml(unit))
      .join('');
  }
}
