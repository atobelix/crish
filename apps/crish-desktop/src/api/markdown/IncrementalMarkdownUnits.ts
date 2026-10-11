import type {
  HtmlPart,
  IncrementalMarkdownFragmentKind,
  IncrementalMarkdownTextPart,
  IncrementalMarkdownUnitKind,
} from './IncrementalMarkdownSession';

export interface IncrementalMarkdownUnitState {
  id: number;
  kind: IncrementalMarkdownUnitKind;
  closed: boolean;
  html: string;
  level?: number;
  tag?: 'ul' | 'ol';
}

/** 保存已经生成的 HTML 单元；更新文本时只重算所属单元的片段。 */
export class IncrementalMarkdownUnitProjection {
  public readonly parts: HtmlPart[] = [];
  public readonly units: IncrementalMarkdownUnitState[] = [];
  public activeUnitId: number | null = null;
  private nextPartId = 1;
  private nextUnitId = 1;

  public reset(): void {
    this.parts.length = 0;
    this.units.length = 0;
    this.activeUnitId = null;
  }

  public appendStatic(value: string): void {
    if (!value) return;
    this.parts.push({ kind: 'static', unitId: this.activeUnitId, value });
    this.refreshUnitHtml(this.activeUnitId);
  }

  public appendFragment(
    source: string,
    kind: IncrementalMarkdownFragmentKind
  ): IncrementalMarkdownTextPart {
    const startedUnit = this.activeUnitId === null;
    if (startedUnit) this.beginUnit(kind === 'block' ? 'block' : 'other');
    const unitId = this.activeUnitId;
    const id = this.nextPartId++;
    this.parts.push({ kind: 'text', id, unitId, value: '' });
    if (startedUnit) this.endUnit();
    return { id, source, kind };
  }

  public beginUnit(kind: IncrementalMarkdownUnitKind, opening = ''): number {
    const id = this.nextUnitId++;
    this.units.push({ id, kind, closed: false, html: '' });
    this.activeUnitId = id;
    if (opening) this.appendStatic(opening);
    return id;
  }

  public endUnit(closing = ''): void {
    if (this.activeUnitId === null) return;
    if (closing) this.appendStatic(closing);
    const unit = this.units.find((candidate) => candidate.id === this.activeUnitId);
    if (unit) unit.closed = true;
    this.activeUnitId = null;
  }

  public refreshUnitHtml(unitId: number | null): void {
    if (unitId === null) return;
    const unit = this.units.find((candidate) => candidate.id === unitId);
    if (!unit) return;
    unit.html = this.parts
      .filter((part) => part.unitId === unitId)
      .map((part) => part.value)
      .join('');
  }

  public openUnitSuffix(
    unit: IncrementalMarkdownUnitState,
    listItemOpen: boolean,
    listTag: 'ul' | 'ol' | null
  ): string {
    if (unit.closed) return '';
    if (unit.kind === 'paragraph') return '</p>';
    if (unit.kind === 'heading') return `</h${unit.level ?? 1}>`;
    if (unit.kind === 'list') {
      return `${listItemOpen ? '</li>' : ''}</${unit.tag ?? listTag ?? 'ul'}>`;
    }
    if (unit.kind === 'blockquote') return '</p></blockquote>';
    if (unit.kind === 'code') return '</code></pre></div>';
    if (unit.kind === 'hr') return '';
    return '';
  }
}
