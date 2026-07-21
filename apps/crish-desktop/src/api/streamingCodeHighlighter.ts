const LINE_CACHE = new Map<string, string>();
const MAX_LINE_CACHE = 10000;

import { highlightCode } from './codeHighlight';

export class StreamingCodeHighlighter {
  private lastLineCount = 0;
  private highlightedLines: string[] = [];
  private language: string;

  constructor(language: string) {
    this.language = language || '';
  }

  push(code: string): string {
    const lines = code.split('\n');
    for (let i = this.lastLineCount; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const key = `${this.language}:${line}`;
      let hl = LINE_CACHE.get(key);
      if (!hl) {
        hl = this.highlightLine(line);
        if (LINE_CACHE.size >= MAX_LINE_CACHE) {
          const firstKey = LINE_CACHE.keys().next().value;
          if (firstKey) LINE_CACHE.delete(firstKey);
        }
        LINE_CACHE.set(key, hl);
      }
      this.highlightedLines[i] = hl;
    }
    this.lastLineCount = lines.length;
    return this.highlightedLines.slice(0, lines.length).join('\n');
  }

  reset(): void {
    this.lastLineCount = 0;
    this.highlightedLines = [];
  }

  private highlightLine(line: string): string {
    if (!line) return '';
    try {
      return highlightCode(line, this.language || undefined);
    } catch {
      return this.escapeHtml(line);
    }
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
