import { IncrementalMarkdownParser, type ChunkUpdate } from './IncrementalMarkdownParser';

export class IncrementalMarkdownBridge {
  private parser = new IncrementalMarkdownParser();
  private lastFullText = '';
  private lastFullHtml = '';

  push(fullText: string): { html: string; updates: ChunkUpdate[] } {
    const changeOffset = this.computeChangeOffset(fullText);
    const updates = this.parser.push(fullText, changeOffset);
    const html = this.parser.getHtml();
    this.lastFullText = fullText;
    this.lastFullHtml = html;
    return { html, updates };
  }

  getFullHtml(): string { return this.lastFullHtml; }

  reset(): void {
    this.parser.reset();
    this.lastFullText = '';
    this.lastFullHtml = '';
  }

  private computeChangeOffset(fullText: string): number {
    if (!this.lastFullText) return 0;
    const minLen = Math.min(this.lastFullText.length, fullText.length);
    let i = 0;
    while (i < minLen && this.lastFullText[i] === fullText[i]) i++;
    return i;
  }
}
