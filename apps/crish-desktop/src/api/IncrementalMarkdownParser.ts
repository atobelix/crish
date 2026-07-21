import { highlightCode } from './codeHighlight';

export type ChunkType = 'heading' | 'paragraph' | 'code_block' | 'list' | 'table' | 'blockquote' | 'thematic_break';

export interface Chunk {
  id: number;
  type: ChunkType;
  offset: number;
  length: number;
  raw: string;
  html: string;
  version: number;
}

export interface ChunkUpdate {
  id: number;
  type: ChunkType;
  raw: string;
  html: string;
  version: number;
}

interface RawChunk {
  type: ChunkType;
  offset: number;
  length: number;
  raw: string;
  lang?: string;
  level?: number;
}

let nextChunkId = 1;

export class IncrementalMarkdownParser {
  private _chunks: Chunk[] = [];

  push(fullText: string, changeOffset: number): ChunkUpdate[] {
    if (this._chunks.length === 0) {
      const raws = this.splitIntoBlocks(fullText, 0);
      return this.buildAll(raws);
    }

    const boundaryStart = this.findBlockStart(fullText, changeOffset);

    const preserved: Chunk[] = [];
    let consumed = 0;
    for (const c of this._chunks) {
      const next = consumed + c.raw.length;
      if (next <= boundaryStart) {
        preserved.push(c);
        consumed = next;
      } else break;
    }

    const affectedText = fullText.slice(boundaryStart);
    const newRaws = this.splitIntoBlocks(affectedText, boundaryStart);

    const oldByRaw = new Map<string, Chunk>();
    for (const c of this._chunks) {
      oldByRaw.set(c.raw, c);
    }

    const built: Chunk[] = [];
    const updates: ChunkUpdate[] = [];
    let runOffset = boundaryStart;

    for (const nr of newRaws) {
      nr.offset = runOffset;
      const existing = oldByRaw.get(nr.raw);
      if (existing && existing.type === nr.type) {
        existing.offset = runOffset;
        existing.length = nr.raw.length;
        built.push(existing);
      } else {
        const html = this.renderHtml(nr);
        const chunk: Chunk = {
          id: nextChunkId++,
          type: nr.type,
          offset: runOffset,
          length: nr.raw.length,
          raw: nr.raw,
          html,
          version: 1,
        };
        built.push(chunk);
        updates.push({ id: chunk.id, type: chunk.type, raw: chunk.raw, html: chunk.html, version: chunk.version });
      }
      runOffset += nr.raw.length;
    }

    this._chunks = [...preserved, ...built];
    return updates;
  }

  getHtml(): string {
    return this._chunks.map(c => c.html).join('');
  }

  /** exposed for testing / debug */
  get chunks(): readonly Chunk[] {
    return this._chunks;
  }

  /** reset parser state */
  reset(): void {
    this._chunks = [];
  }

  // ── internal ──

  private findBlockStart(text: string, offset: number): number {
    if (offset <= 0) return 0;
    const clamped = Math.min(offset, text.length);
    if (clamped === 0) return 0;

    let lineStart = clamped;
    while (lineStart > 0 && text[lineStart - 1] !== '\n') {
      lineStart--;
    }

    let pos = lineStart;
    while (pos > 0) {
      let prevEnd = pos;
      if (prevEnd > 0 && text[prevEnd - 1] === '\n') prevEnd--;
      let prevStart = prevEnd;
      while (prevStart > 0 && text[prevStart - 1] !== '\n') {
        prevStart--;
      }
      const prevLine = text.slice(prevStart, prevEnd);
      if (prevLine.trim() === '') return pos;
      pos = prevStart;
    }

    return 0;
  }

  private parseToHtml(text: string): string {
    const raws = this.splitIntoBlocks(text, 0);
    return raws.map(r => this.renderHtml(r)).join('');
  }

  private splitIntoBlocks(text: string, baseOffset: number): RawChunk[] {
    if (!text) return [];
    const result: RawChunk[] = [];
    let pos = 0;

    while (pos < text.length) {
      const lineEnd = text.indexOf('\n', pos);
      const isLast = lineEnd === -1;
      const line = isLast ? text.slice(pos) : text.slice(pos, lineEnd);
      const lineLen = isLast ? line.length : line.length + 1;
      const offset = baseOffset + pos;

      if (line.trim() === '') {
        pos += lineLen;
        continue;
      }

      const hMatch = line.match(/^(#{1,6})\s/);
      if (hMatch) {
        const raw = text.slice(pos, pos + lineLen);
        result.push({ type: 'heading', offset, length: raw.length, raw, level: hMatch[1].length });
        pos += lineLen;
        continue;
      }

      if (/^`{3,}/.test(line)) {
        const fence = line.match(/^(`+)/)![1]!;
        const fenceLen = fence.length;
        const fenceChar = fence[0]!;
        const closePattern = new RegExp(`^ {0,3}\\${fenceChar}{${fenceLen},}\\s*$`);
        const lang = line.slice(fenceLen).trim();
        let closeEnd = -1;
        let searchPos = pos + lineLen;
        while (searchPos < text.length) {
          const nextNl = text.indexOf('\n', searchPos);
          const thisLineEnd = nextNl === -1 ? text.length : nextNl;
          const thisLine = text.slice(searchPos, thisLineEnd);
          if (closePattern.test(thisLine)) {
            closeEnd = nextNl === -1 ? text.length : nextNl + 1;
            break;
          }
          searchPos = nextNl === -1 ? text.length : nextNl + 1;
        }
        const raw = closeEnd === -1
          ? text.slice(pos)
          : text.slice(pos, closeEnd);
        result.push({ type: 'code_block', offset, length: raw.length, raw, lang });
        pos += raw.length;
        continue;
      }

      if (/^ {0,3}>/.test(line)) {
        let endPos = pos + lineLen;
        while (endPos < text.length) {
          const nextNl = text.indexOf('\n', endPos);
          const nl = nextNl === -1 ? text.length : nextNl + 1;
          const nLine = text.slice(endPos, nextNl === -1 ? text.length : nextNl);
          if (nLine.trim() === '' || !/^ {0,3}>/.test(nLine)) break;
          endPos = nl;
        }
        const raw = text.slice(pos, Math.min(endPos, text.length));
        if (raw.trim()) result.push({ type: 'blockquote', offset, length: raw.length, raw });
        pos += raw.length;
        continue;
      }

      if (/^(\s*)[-*+]\s/.test(line) || /^(\s*)\d+\.\s/.test(line)) {
        let endPos = pos + lineLen;
        while (endPos < text.length) {
          const nextNl = text.indexOf('\n', endPos);
          const nl = nextNl === -1 ? text.length : nextNl + 1;
          const nLine = text.slice(endPos, nextNl === -1 ? text.length : nextNl);
          if (nLine.trim() === '') {
            const afterBlank = text.indexOf('\n', nl);
            if (afterBlank !== -1) {
              const checkLine = text.slice(nl, afterBlank === -1 ? text.length : afterBlank).trim();
              if (checkLine && (/^[-*+]\s/.test(checkLine) || /^\d+\.\s/.test(checkLine))) {
                endPos = nl;
                continue;
              }
            }
            break;
          }
          if (/^(\s*)[-*+]\s/.test(nLine) || /^(\s*)\d+\.\s/.test(nLine)) {
            endPos = nl;
            continue;
          }
          const baseIndent = (line.match(/^(\s*)/)?.[1]?.length ?? 0);
          const nextIndent = (nLine.match(/^(\s*)/)?.[1]?.length ?? 0);
          if (nextIndent > baseIndent) {
            endPos = nl;
            continue;
          }
          break;
        }
        const raw = text.slice(pos, Math.min(endPos, text.length));
        if (raw.trim()) result.push({ type: 'list', offset, length: raw.length, raw });
        pos += raw.length;
        continue;
      }

      if (/^(?:---|\*\*\*|___)\s*$/.test(line.trim())) {
        const raw = text.slice(pos, pos + lineLen);
        result.push({ type: 'thematic_break', offset, length: raw.length, raw });
        pos += lineLen;
        continue;
      }

      if (line.includes('|') && line.trim().startsWith('|')) {
        let endPos = pos + lineLen;
        while (endPos < text.length) {
          const nextNl = text.indexOf('\n', endPos);
          const nl = nextNl === -1 ? text.length : nextNl + 1;
          const nLine = text.slice(endPos, nextNl === -1 ? text.length : nextNl);
          if (nLine.trim() === '' || !nLine.includes('|')) break;
          endPos = nl;
        }
        const raw = text.slice(pos, Math.min(endPos, text.length));
        if (raw.trim()) result.push({ type: 'table', offset, length: raw.length, raw });
        pos += raw.length;
        continue;
      }

      let endPos = pos + lineLen;
      while (endPos < text.length) {
        const nextNl = text.indexOf('\n', endPos);
        const nl = nextNl === -1 ? text.length : nextNl + 1;
        const nLine = text.slice(endPos, nextNl === -1 ? text.length : nextNl);
        if (nLine.trim() === '') break;
        if (/^#{1,6}\s/.test(nLine)) break;
        if (/^`{3,}/.test(nLine)) break;
        endPos = nl;
      }
      const raw = text.slice(pos, Math.min(endPos, text.length));
      if (raw.trim()) result.push({ type: 'paragraph', offset, length: raw.length, raw });
      pos = endPos;
    }

    return result;
  }

  private renderHtml(rc: RawChunk): string {
    switch (rc.type) {
      case 'heading':
        return this.renderHeading(rc);
      case 'paragraph':
        return this.renderParagraph(rc);
      case 'code_block':
        return this.renderCodeBlock(rc);
      case 'list':
        return this.renderList(rc);
      case 'blockquote':
        return this.renderBlockquote(rc);
      case 'thematic_break':
        return '<hr class="md-hr" />';
      case 'table':
        return this.renderTable(rc);
      default:
        return '';
    }
  }

  private escapeHtml(s: string): string {
    if (!s) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private applyInline(text: string): string {
    const codes: string[] = [];
    let s = text.replace(/`([^`\n]+)`/g, (_, code: string) => {
      const i = codes.length;
      codes.push(`<code class="md-inline-code">${this.escapeHtml(code)}</code>`);
      return `\x00CODE${i}\x00`;
    });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(
      /(^|.)\*(?![\s*])([^*\n]+?)\*(?!\*)/g,
      (_m, before, content) => {
        if (before === '*' || /\s$/.test(content)) return _m;
        return before + '<em>' + content + '</em>';
      },
    );
    s = s.replace(/\x00CODE(\d+)\x00/g, (_, i) => codes[Number(i)] || '');
    s = s.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_m, t: string, url: string) => {
        const safeUrl = this.escapeHtml(url);
        const safeText = this.escapeHtml(t);
        return `<a class="md-a" href="${safeUrl}" target="_blank" rel="noreferrer">${safeText}</a>`;
      },
    );
    return s;
  }

  private renderHeading(rc: RawChunk): string {
    const level = rc.level ?? 1;
    const clamped = Math.min(Math.max(level, 1), 6);
    const content = rc.raw.replace(/^#{1,6}\s+/, '').replace(/\n$/, '');
    const inline = this.applyInline(this.escapeHtml(content));
    return `<h${clamped} class="md-h${clamped}">${inline}</h${clamped}>`;
  }

  private renderParagraph(rc: RawChunk): string {
    const text = rc.raw.replace(/\n$/, '');
    const escaped = this.escapeHtml(text);
    const inline = this.applyInline(escaped).replace(/\n/g, '<br />');
    return `<p class="md-p">${inline}</p>`;
  }

  private renderCodeBlock(rc: RawChunk): string {
    const raw = rc.raw;
    const firstNl = raw.indexOf('\n');
    const firstLine = firstNl === -1 ? raw : raw.slice(0, firstNl);
    const fenceMatch = firstLine.match(/^(`+)/);
    const fenceLen = fenceMatch ? fenceMatch[1].length : 3;
    const closeReg = new RegExp(`\n {0,3}\`{${fenceLen},}\\s*$`);
    const body = firstNl === -1 ? '' : raw.slice(firstNl + 1).replace(closeReg, '').replace(/\n$/, '');
    const lang = rc.lang ?? '';
    const inner = highlightCode(body, lang);
    const langBadge = lang
      ? `<span class="md-code-lang" data-lang="${this.escapeHtml(lang)}">${this.escapeHtml(lang)}</span>`
      : '';
    return `<div class="md-code-block"><button type="button" class="md-code-copy">复制</button>${langBadge}<pre class="md-code-pre"><code class="language-${this.escapeHtml(lang)}">${inner}</code></pre></div>`;
  }

  private renderList(rc: RawChunk): string {
    const items: string[] = [];
    const lines = rc.raw.replace(/\n$/, '').split('\n');
    let isOrdered = true;
    let isTaskList = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        items[items.length - 1] += '\n';
        continue;
      }
      const isDigit = /^\d+\.\s/.test(trimmed);
      if (!isDigit) isOrdered = false;

      const markerRegex = /^(?:[-*+]|\d+\.)\s+/;
      const taskCheckboxRegex = /^\[([ x])\]\s+/i;
      let content = trimmed.replace(markerRegex, '');
      const taskMatch = content.match(taskCheckboxRegex);
      if (taskMatch) {
        isTaskList = true;
        const checked = taskMatch[1].toLowerCase() === 'x';
        const checkbox = checked
          ? '<input type="checkbox" checked disabled>'
          : '<input type="checkbox" disabled>';
        content = content.replace(taskCheckboxRegex, '');
        const escapedContent = this.escapeHtml(content);
        const inlineContent = this.applyInline(escapedContent);
        items.push(`<li class="md-li">${checkbox} ${inlineContent}</li>`);
      } else {
        const escaped = this.escapeHtml(content);
        const inline = this.applyInline(escaped);
        items.push(`<li class="md-li">${inline}</li>`);
      }
    }

    const wrapper = isOrdered ? 'ol' : 'ul';
    const cls = isOrdered ? 'md-ol' : 'md-ul';
    return `<${wrapper} class="${cls}">${items.join('')}</${wrapper}>`;
  }

  private renderBlockquote(rc: RawChunk): string {
    const content = rc.raw
      .split('\n')
      .map(l => l.replace(/^ {0,3}> ?/, ''))
      .join('\n');
    return `<blockquote class="md-blockquote">${this.parseToHtml(content)}</blockquote>`;
  }

  private renderTable(rc: RawChunk): string {
    const lines = rc.raw.replace(/\n$/, '').split('\n');
    if (lines.length < 2) return '';

    const headerCells = this.splitTableRow(lines[0]!);
    const aligns = this.parseAlignments(lines[1]!);
    const colCount = headerCells.length;
    const normAligns = aligns.slice(0, colCount);
    while (normAligns.length < colCount) normAligns.push('left');

    const ths = headerCells
      .map((c, i) => {
        const align = normAligns[i]!;
        const attr = align !== 'left' ? ` style="text-align:${align}"` : '';
        return `<th class="md-th" scope="col"${attr}>${this.applyInline(this.escapeHtml(c))}</th>`;
      })
      .join('');

    const bodyRows: string[] = [];
    for (let i = 2; i < lines.length; i++) {
      const cells = this.splitTableRow(lines[i]!);
      let tds = cells
        .slice(0, colCount)
        .map((c, j) => {
          const align = (normAligns[j] ?? 'left');
          const attr = align !== 'left' ? ` style="text-align:${align}"` : '';
          return `<td class="md-td"${attr}>${this.applyInline(this.escapeHtml(c))}</td>`;
        })
        .join('');
      while (tds.split('<td').length - 1 < colCount) {
        tds += '<td class="md-td"></td>';
      }
      bodyRows.push(`<tr class="md-tr">${tds}</tr>`);
    }

    return `<div class="md-table-wrap" role="region" aria-label="表格"><table class="md-table"><thead><tr class="md-tr">${ths}</tr></thead><tbody>${bodyRows.join('')}</tbody></table></div>`;
  }

  private splitTableRow(line: string): string[] {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    const cells: string[] = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && i + 1 < s.length && s[i + 1] === '|') {
        cur += '|';
        i++;
        continue;
      }
      if (s[i] === '|') {
        cells.push(cur.trim());
        cur = '';
        continue;
      }
      cur += s[i];
    }
    cells.push(cur.trim());
    return cells;
  }

  private parseAlignments(sepLine: string): Array<'left' | 'center' | 'right'> {
    return this.splitTableRow(sepLine).map(c => {
      const t = c.trim();
      const left = t.startsWith(':');
      const right = t.endsWith(':');
      if (left && right) return 'center';
      if (right) return 'right';
      return 'left';
    });
  }

  private buildAll(raws: RawChunk[]): ChunkUpdate[] {
    const updates: ChunkUpdate[] = [];
    const built: Chunk[] = [];
    for (const nr of raws) {
      const html = this.renderHtml(nr);
      const chunk: Chunk = {
        id: nextChunkId++,
        type: nr.type,
        offset: nr.offset,
        length: nr.raw.length,
        raw: nr.raw,
        html,
        version: 1,
      };
      built.push(chunk);
      updates.push({ id: chunk.id, type: chunk.type, raw: chunk.raw, html: chunk.html, version: chunk.version });
    }
    this._chunks = built;
    return updates;
  }
}
